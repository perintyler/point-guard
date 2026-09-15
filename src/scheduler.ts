/**
 * The delegation lifecycle owner: dispatch, the attempt/verify cycle, the
 * fresh-context retry ladder, concurrency slots, and startup reconciliation.
 *
 * Callers propose; this file disposes. Every transition goes through the
 * store's guarded UPDATEs, and every path out of an attempt ends in a
 * recorded, terminal, explainable state.
 */
import { createHash, randomUUID } from "node:crypto";
import { createLogger } from "@barry-rocks/logger";
import { DelegationBriefSchema, PlanSchema, type DelegationBrief, type Plan, type PlanStep } from "./contracts.js";
import { hashFileAtCommit, resolveSha, removeWorktreeSafe } from "./gitwt.js";
import { executeAttempt } from "./worker.js";
import { computeEligibility, confirmArtifact, verifyCandidate } from "./verifier.js";
import type { PointGuardStore } from "./store.js";
import type { SingleRunOptions } from "./run-single.js";

const log = createLogger("point-guard:scheduler");

/** Practitioner band is 4-8; the plan starts at one and enables four after
 * concurrency tests pass. The cap is enforced here, not in the prompt. */
export const MAX_CONCURRENT_WORKERS = 4;

export interface SchedulerOptions {
  store: PointGuardStore;
  maxConcurrentWorkers?: number;
  /** Test seams. */
  workerRunnerFactory?: SingleRunOptions["runnerFactory"];
  judgeRunnerFactory?: SingleRunOptions["runnerFactory"];
  sessionProjection?: boolean;
}

export interface DispatchResult {
  ok: boolean;
  delegationId?: string;
  error?: string;
}

export class Scheduler {
  private readonly store: PointGuardStore;
  private readonly maxWorkers: number;
  private readonly workerRunnerFactory?: SingleRunOptions["runnerFactory"];
  private readonly judgeRunnerFactory?: SingleRunOptions["runnerFactory"];
  private readonly sessionProjection: boolean;
  /** In-flight attempt promises by delegation id — the in-process slot claim.
   * The DB `runs` table is the cross-restart record; this map is the live
   * mutex (one service owner per database, so in-process is sufficient). */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(options: SchedulerOptions) {
    this.store = options.store;
    this.maxWorkers = options.maxConcurrentWorkers ?? MAX_CONCURRENT_WORKERS;
    this.workerRunnerFactory = options.workerRunnerFactory;
    this.judgeRunnerFactory = options.judgeRunnerFactory;
    this.sessionProjection = options.sessionProjection !== false;
  }

  activeWorkerCount(): number {
    return this.inFlight.size;
  }

  /**
   * Validate a brief, freeze the contract (baseline SHA + protected-file
   * hashes), and create the queued delegation. Nothing executes yet.
   */
  async dispatch(rawBrief: unknown, conversationId?: string): Promise<DispatchResult> {
    const parsed = DelegationBriefSchema.safeParse(rawBrief);
    if (!parsed.success) {
      return { ok: false, error: `invalid brief: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
    }
    const brief = parsed.data;

    let baselineSha: string;
    try {
      baselineSha = await resolveSha(brief.repo, brief.targetRef);
    } catch (error) {
      return { ok: false, error: `cannot resolve ${brief.targetRef} in ${brief.repo}: ${String(error)}` };
    }

    // Freeze protected-file hashes AT THE BASELINE. Verification compares the
    // candidate against these frozen values; comparing against a re-read
    // would let tampered state vouch for itself.
    const protectedFileHashes: Record<string, string> = {};
    for (const path of brief.protectedFiles) {
      protectedFileHashes[path] = await hashFileAtCommit(brief.repo, baselineSha, path);
    }

    const briefJson = JSON.stringify(brief);
    const contractHash = createHash("sha256")
      .update(briefJson)
      .update(baselineSha)
      .update(JSON.stringify(protectedFileHashes))
      .digest("hex");

    const row = this.store.createDelegation({
      conversationId,
      brief,
      briefJson,
      contractHash,
      baselineSha,
      dispatchJson: JSON.stringify({ protectedFileHashes, dispatchedAt: Date.now() }),
    });
    log.info(`dispatched ${row.id}: ${brief.objective.slice(0, 80)}`);
    return { ok: true, delegationId: row.id };
  }

  briefFor(delegationId: string): DelegationBrief | undefined {
    const row = this.store.getDelegation(delegationId);
    if (!row) return undefined;
    return DelegationBriefSchema.parse(JSON.parse(row.brief_json));
  }

  protectedHashesFor(delegationId: string): Record<string, string> {
    const row = this.store.getDelegation(delegationId);
    if (!row?.dispatch_json) return {};
    try {
      return (JSON.parse(row.dispatch_json) as { protectedFileHashes?: Record<string, string> }).protectedFileHashes ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Run the next attempt for a queued delegation, verify the candidate, and
   * settle the state. Returns when the cycle completes. Refuses (returns
   * false) when no slot is free or the delegation is not claimable — the
   * caller polls again; nothing blocks.
   */
  async runCycle(delegationId: string): Promise<boolean> {
    if (this.inFlight.has(delegationId)) return false;
    if (this.inFlight.size >= this.maxWorkers) return false;

    const row = this.store.getDelegation(delegationId);
    if (!row) return false;
    const brief = this.briefFor(delegationId);
    if (!brief) return false;

    if (row.attempt_count >= brief.attemptLimit) {
      // At the cap: stop and ask the user (plan: Durable State). blocked is a
      // terminal-until-human state, not a retry state.
      this.store.transitionDelegation(delegationId, ["queued"], "blocked", `attempt cap (${brief.attemptLimit}) reached`);
      return false;
    }

    if (!this.store.transitionDelegation(delegationId, "queued", "running")) return false;

    const cycle = this.executeCycle(delegationId, row.baseline_sha, brief).finally(() => {
      this.inFlight.delete(delegationId);
    });
    this.inFlight.set(delegationId, cycle);
    await cycle;
    return true;
  }

  private async executeCycle(delegationId: string, baselineSha: string, brief: DelegationBrief): Promise<void> {
    const attemptNumber = this.store.incrementAttempts(delegationId);
    const failureContext = this.distilledFailure(delegationId);

    let outcome;
    try {
      outcome = await executeAttempt({
        store: this.store,
        delegationId,
        attemptNumber,
        brief,
        baselineSha,
        failureContext,
        runnerFactory: this.workerRunnerFactory,
        sessionProjection: this.sessionProjection,
      });
    } catch (error) {
      // Infrastructure failure, not a code defect (plan: Durable State) —
      // report it as what it is.
      this.settleFailure(delegationId, brief, attemptNumber, `infrastructure: ${String(error)}`);
      return;
    }

    if (!outcome.ok || !outcome.report) {
      this.settleFailure(delegationId, brief, attemptNumber, outcome.error ?? "attempt failed without detail");
      return;
    }

    if (!this.store.transitionDelegation(delegationId, "running", "verifying")) return;

    const artifact = await confirmArtifact({
      repo: brief.repo,
      worktreePath: outcome.worktreePath,
      branch: outcome.branch,
      baselineSha,
      report: outcome.report,
    });
    if (!artifact.ok || !artifact.candidateSha) {
      this.store.addEvidence({
        delegationId,
        runId: outcome.runId,
        candidateSha: outcome.report.candidateSha,
        contractHash: this.store.getDelegation(delegationId)!.contract_hash,
        kind: "mechanical",
        payload: { artifactFailures: artifact.failures },
      });
      this.settleVerificationFailure(delegationId, brief, attemptNumber, artifact.failures);
      return;
    }

    const contractHash = this.store.getDelegation(delegationId)!.contract_hash;
    this.store.addEvidence({
      delegationId,
      runId: outcome.runId,
      candidateSha: artifact.candidateSha,
      contractHash,
      kind: "report",
      payload: outcome.report,
    });

    const verification = await verifyCandidate({
      repo: brief.repo,
      brief,
      baselineSha,
      candidateSha: artifact.candidateSha,
      contractHash,
      protectedFileHashes: this.protectedHashesFor(delegationId),
      delegationId,
      attemptNumber,
      judgeRunnerFactory: this.judgeRunnerFactory,
    });

    this.store.addEvidence({ delegationId, candidateSha: artifact.candidateSha, contractHash, kind: "mechanical", payload: verification.mechanical });
    this.store.addEvidence({ delegationId, candidateSha: artifact.candidateSha, contractHash, kind: "diff", payload: { diff: verification.diff } });
    if (verification.judge.report) {
      this.store.addEvidence({ delegationId, candidateSha: artifact.candidateSha, contractHash, kind: "judge", payload: verification.judge.report });
    }

    const eligibility = computeEligibility({
      report: outcome.report,
      mechanical: verification.mechanical,
      judge: verification.judge,
      brief,
    });

    if (eligibility.eligible) {
      this.store.transitionDelegation(delegationId, "verifying", "accepted", `candidate ${artifact.candidateSha.slice(0, 12)}`);
      this.store.emitEvent("delegation.accepted", { delegationId, candidateSha: artifact.candidateSha });
      // The verification checkout served its purpose; the WORKER worktree is
      // retained until integration completes (publication is not permission
      // to destroy an unexamined worktree — and acceptance certainly is not).
      await removeWorktreeSafe(brief.repo, verification.checkoutPath, "");
      return;
    }

    this.settleVerificationFailure(delegationId, brief, attemptNumber, eligibility.reasons);
  }

  private settleFailure(delegationId: string, brief: DelegationBrief, attemptNumber: number, reason: string): void {
    if (attemptNumber >= brief.attemptLimit) {
      this.store.transitionDelegation(delegationId, ["running", "verifying"], "blocked", `attempt ${attemptNumber} failed and cap reached: ${reason}`);
    } else {
      this.store.transitionDelegation(delegationId, ["running", "verifying"], "queued", `attempt ${attemptNumber} failed: ${reason}`);
    }
  }

  private settleVerificationFailure(delegationId: string, brief: DelegationBrief, attemptNumber: number, reasons: string[]): void {
    const summary = reasons.slice(0, 10).join("; ");
    this.settleFailure(delegationId, brief, attemptNumber, summary);
  }

  /**
   * The distilled failure summary for the NEXT fresh attempt: contract-level
   * evidence only, never the failed transcript (contaminated-context retries
   * cascade — the research's strongest single result).
   */
  distilledFailure(delegationId: string): string | undefined {
    const row = this.store.getDelegation(delegationId);
    if (!row || row.attempt_count === 0) return undefined;
    const lines: string[] = [];
    if (row.reason) lines.push(`Last attempt outcome: ${row.reason}`);
    const mech = this.store.evidenceFor(delegationId, "mechanical").at(-1);
    if (mech) {
      const payload = mech.payload as { failures?: string[]; artifactFailures?: string[] };
      for (const f of payload.failures ?? payload.artifactFailures ?? []) lines.push(`- ${f}`);
    }
    const judge = this.store.evidenceFor(delegationId, "judge").at(-1);
    if (judge) {
      const payload = judge.payload as { findings?: Array<{ severity: string; file: string; rationale: string }> };
      for (const f of payload.findings ?? []) {
        if (f.severity === "BLOCKER" || f.severity === "MAJOR") lines.push(`- judge: ${f.file}: ${f.rationale}`);
      }
    }
    return lines.length ? lines.join("\n").slice(0, 4_000) : undefined;
  }

  /**
   * Startup reconciliation (plan: Durable State and Recovery). Runs marked
   * `running` whose owner process is gone did NOT survive the crash — the
   * child was our descendant. Mark them unknown->failed and re-queue their
   * delegations within budget. Never silently launch a replacement beside an
   * unaccounted-for worker: this runs BEFORE dispatch resumes.
   */
  // ------------------------------------------------------------------ plans

  /**
   * Accept a plan (validated already; contracts.PlanSchema is the source of
   * truth). This is the ONLY dispatch-adjacent method that constructs
   * delegations from something other than a directly-submitted brief — and
   * even here, it copies each step's fields VERBATIM into a
   * DelegationBrief. Point-guard does not rephrase objectives, invent
   * acceptance checks, or reorder steps; it only resolves the dependency
   * graph the plan already specifies.
   */
  async intakePlan(plan: Plan): Promise<{ planId: string; created: boolean }> {
    const result = this.store.intakePlan(
      { planId: plan.planId, repo: plan.repo, targetRef: plan.targetRef, steps: plan.steps },
      JSON.stringify(plan.steps),
    );
    if (result.created) {
      log.info(`plan ${result.planId} intake: ${plan.steps.length} step(s)`);
    }
    return result;
  }

  /**
   * Fan out whatever is currently runnable for a plan, and set up settlement
   * so completing/failing a step automatically re-queries for newly-
   * unblocked dependents. Safe to call repeatedly (idempotent: a step
   * already `in_progress`/terminal is never re-dispatched, per
   * nextRunnableSteps/claimPlanStep's guards) — this is what both the
   * initial `submit_plan` call and a post-restart resume pass invoke.
   */
  async runPlan(planId: string): Promise<{ dispatched: string[] }> {
    const plan = this.store.getPlan(planId);
    if (!plan) return { dispatched: [] };

    // Re-arm steps already claimed whose delegation stalled `queued` (a
    // retry-ladder requeue, or a crash-recovery requeue) with no cycle
    // currently in flight for it — nextRunnableSteps below only ever sees
    // brand-new `queued` STEPS, never an already-in_progress one.
    const dispatched: string[] = [];
    for (const stalled of this.store.stalledInProgressSteps(planId)) {
      void this.runCycle(stalled.delegation_id)
        .then(() => this.onPlanDelegationSettled(planId, stalled.step_id, stalled.delegation_id))
        .catch((error) => log.error(`plan ${planId} step ${stalled.step_id} re-arm cycle threw: ${String(error)}`));
    }

    const runnable = this.store.nextRunnableSteps(planId);
    for (const step of runnable) {
      const brief = this.briefFromStep(plan.target_ref, plan.repo, step);
      const result = await this.dispatch(brief);
      if (!result.ok || !result.delegationId) {
        // A malformed step contract fails the STEP, not the whole plan —
        // other independent steps may still be able to proceed.
        this.store.settlePlanStep(planId, step.id, "failed", { summary: "", limitations: result.error ?? "dispatch failed" });
        continue;
      }
      const claimed = this.store.claimPlanStep(planId, step.id, result.delegationId);
      if (!claimed) continue; // lost a race to a concurrent runPlan call; the other claim wins
      dispatched.push(step.id);
      void this.runCycle(result.delegationId)
        .then(() => this.onPlanDelegationSettled(planId, step.id, result.delegationId!))
        .catch((error) => log.error(`plan ${planId} step ${step.id} cycle threw: ${String(error)}`));
    }
    return { dispatched };
  }

  private briefFromStep(targetRef: string, repo: string, step: PlanStep): DelegationBrief {
    return DelegationBriefSchema.parse({
      objective: step.text,
      requirements: step.requirements,
      repo,
      targetRef,
      fileScope: step.fileScope,
      acceptanceChecks: step.acceptanceChecks,
      protectedFiles: step.protectedFiles,
      provider: step.provider,
      ...(step.model ? { model: step.model } : {}),
    });
  }

  /**
   * Called once a plan-owned delegation's cycle resolves. `accepted` ->
   * auto-merge (submitting a plan IS the approval; this is the one place
   * point-guard bypasses the human confirm-merge click — every mechanical/
   * judge gate still re-runs at integration, unchanged). `merged` -> step
   * `done`, and fan out whatever just became runnable. `blocked`/`failed`
   * -> step `failed`; independent sibling steps are unaffected, but any
   * step depending on this one never becomes runnable (nextRunnableSteps
   * requires `done`, not `failed`) — a stuck plan is visible via
   * check_plan, never silently abandoned.
   */
  private async onPlanDelegationSettled(planId: string, stepId: string, delegationId: string): Promise<void> {
    let row = this.store.getDelegation(delegationId);
    if (!row) return;

    if (row.state === "accepted") {
      await this.autoMergePlanStep(planId, stepId, delegationId);
      // Re-fetch: autoMergePlanStep may have advanced the delegation all the
      // way to `merged` (or left it `accepted` on a failed/starved pass, to
      // be retried by the next settlement or resume). The bug this replaced:
      // returning here unconditionally and assuming "runs again after merge
      // resolves" — nothing ever called this function a second time, so a
      // successful merge silently never settled its plan step.
      row = this.store.getDelegation(delegationId);
      if (!row) return;
    }

    if (row.state === "merged") {
      const report = this.store.evidenceFor(delegationId, "report").at(-1)?.payload as
        | { summary?: string; limitations?: string }
        | undefined;
      this.store.settlePlanStep(planId, stepId, "done", {
        summary: report?.summary ?? "",
        limitations: report?.limitations ?? "",
      });
      await this.runPlan(planId); // fan out newly-unblocked dependents
      return;
    }

    if (row.state === "blocked" || row.state === "failed" || row.state === "cancelled") {
      this.store.settlePlanStep(planId, stepId, "failed", { summary: "", limitations: row.reason ?? "delegation did not reach an acceptable state" });
      return;
    }

    if (row.state === "queued") {
      // A failed attempt requeues WITHIN the same delegation's attempt
      // budget (the normal retry ladder) — this is not a terminal state,
      // just the next attempt waiting for a slot. Nothing else re-drives a
      // plan-owned delegation's retries (the startup/admin resume passes
      // only run at restart or on demand), so this function must do it
      // itself or a retried step hangs `in_progress` forever with no
      // process ever calling runCycle for it again. Fire-and-forget, same
      // pattern as the initial dispatch in runPlan.
      void this.runCycle(delegationId)
        .then(() => this.onPlanDelegationSettled(planId, stepId, delegationId))
        .catch((error) => log.error(`plan ${planId} step ${stepId} retry cycle threw: ${String(error)}`));
      return;
    }
    // running/verifying/integrating: a cycle is genuinely still in flight
    // (this can happen if onPlanDelegationSettled is invoked speculatively,
    // e.g. by a resume pass, while the original .then() chain is still
    // pending) — that original chain will call this function again when it
    // resolves; nothing to do here.
    // queued/running/verifying/integrating: the cycle isn't actually over
    // (e.g. a retry re-queued it) — onPlanDelegationSettled will be called
    // again by the NEXT cycle's resolution; nothing to do yet.
  }

  /** Auto-merge is injected via a callback rather than importing MergeProcessor
   * directly, to avoid a scheduler<->merge circular import — merge.ts already
   * depends on Scheduler for briefFor/protectedHashesFor. Wired once at
   * construction (server/src/index.ts). */
  private autoMergeHook?: (delegationId: string) => Promise<boolean>;
  setAutoMergeHook(hook: (delegationId: string) => Promise<boolean>): void {
    this.autoMergeHook = hook;
  }
  private async autoMergePlanStep(planId: string, stepId: string, delegationId: string): Promise<boolean> {
    if (!this.autoMergeHook) {
      log.warn(`plan ${planId} step ${stepId} accepted but no auto-merge hook wired; leaving accepted for manual confirm-merge`);
      return false;
    }
    try {
      return await this.autoMergeHook(delegationId);
    } catch (error) {
      log.error(`plan ${planId} step ${stepId} auto-merge threw: ${String(error)}`);
      return false;
    }
  }

  reconcileOnStartup(): { reconciled: number; integratingRequeued: number; staleMergesReclaimed: number } {
    let reconciled = 0;
    for (const run of this.store.runningRuns()) {
      const ownedByLivingProcess = run.pid === process.pid;
      if (ownedByLivingProcess) continue; // impossible on startup, defensive
      const finished = this.store.finishRun(run.id, "unknown", {
        failureReason: "service restarted while run was in flight; child was our descendant and died with us",
      });
      if (!finished) continue;
      reconciled += 1;
      if (run.delegation_id) {
        const row = this.store.getDelegation(run.delegation_id);
        if (row && (row.state === "running" || row.state === "verifying")) {
          const brief = this.briefFor(run.delegation_id);
          const capReached = brief ? row.attempt_count >= brief.attemptLimit : true;
          this.store.transitionDelegation(
            run.delegation_id,
            [row.state],
            capReached ? "blocked" : "queued",
            "recovered after service restart",
          );
        }
      }
      this.store.recordLedger({
        delegationId: run.delegation_id ?? undefined,
        runId: run.id,
        kind: "unknown-outcome",
        note: "cost of interrupted run is unknown, not zero",
      });
    }
    if (reconciled > 0) log.warn(`startup reconciliation resolved ${reconciled} interrupted run(s)`);

    // A delegation that crashed strictly BEFORE the publish-intent window
    // (merge.ts writes `publication_intent_at` only once integration+re-
    // verification succeed) is untouched by recoverPublishing() — it never
    // reached a state that function looks at. Left alone, it sits in
    // `integrating` forever. `integrating -> queued` is already a legal
    // edge (DELEGATION_TRANSITIONS), so this is a normal re-queue, not a
    // new state.
    let integratingRequeued = 0;
    for (const row of this.store.listDelegations({ state: "integrating" })) {
      const brief = this.briefFor(row.id);
      const capReached = brief ? row.attempt_count >= brief.attemptLimit : true;
      const moved = this.store.transitionDelegation(
        row.id,
        "integrating",
        capReached ? "blocked" : "queued",
        "crashed before publish intent; re-integration required",
      );
      if (moved) integratingRequeued += 1;
    }
    if (integratingRequeued > 0) log.warn(`re-queued ${integratingRequeued} delegation(s) stuck mid-integration`);

    // Reclaim merge_queue rows left `claimed`/`integrated` by a delegation
    // the pass above already moved out of `integrating` — those rows still
    // occupy claimNextMerge's one-in-flight-per-target slot and would
    // otherwise starve every future merge to that (repo, targetRef)
    // permanently, not just until the next restart.
    let staleMergesReclaimed = 0;
    for (const stale of this.store.staleClaimedMerges()) {
      this.store.updateMerge(stale.id, {
        state: "failed",
        reason: "orphaned by crash; delegation re-queued separately",
      });
      staleMergesReclaimed += 1;
    }
    if (staleMergesReclaimed > 0) log.warn(`reclaimed ${staleMergesReclaimed} stale merge-queue row(s)`);

    return { reconciled, integratingRequeued, staleMergesReclaimed };
  }
}
