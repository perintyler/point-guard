/**
 * The point-guard service: HTTP + WS on 3868, loopback only. Owns the SQLite
 * store, the scheduler, the merge queue, startup recovery, the outbox
 * flusher, and the book -- a periodic supervisor tick that recomputes what
 * Barry's active sessions are doing (GET /book). Everything externally
 * visible is durable first.
 */
import { createServer } from "node:http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createLogger } from "@barry-rocks/logger";
import { PointGuardStore } from "../../src/store.js";
import { Scheduler } from "../../src/scheduler.js";
import { MergeProcessor } from "../../src/merge.js";
import { PlanSchema } from "../../src/contracts.js";
import { commonDir, pruneOrphanedWorktrees } from "../../src/gitwt.js";
import { runSupervisorTick } from "../../src/supervisor.js";
import { runMergeTreeBackstop } from "../../src/merge-tree-backstop.js";
import { handleMessage } from "../../src/message.js";
import { generateNarrative, shouldRegenerate, NARRATIVE_INTERVAL_MS } from "../../src/debrief-narrative.js";
import type { Debrief } from "../../src/debrief.js";
import { notify } from "../../src/notify.js";
import { resolveSha } from "../../src/gitwt.js";

const log = createLogger("point-guard");

const PORT = Number(process.env.BARRY_POINT_GUARD_PORT ?? 3868);
const SECRET = process.env.BARRY_SECRET ?? "";
const RECONCILE_INTERVAL_MS = 300_000;
const OUTBOX_INTERVAL_MS = 30_000;
const HEARTBEAT_MS = 30_000;
const SUPERVISOR_TICK_INTERVAL_MS = 60_000;
// The backstop is a git-merge-tree simulation per pair of sessions sharing
// a repo -- real work, unlike the main tick's SQL-only reads. A slower
// interval keeps it from competing with the main tick for CPU on a
// machine running several concurrent sessions.
const MERGE_TREE_BACKSTOP_INTERVAL_MS = 300_000;
// The narrative is prose about the structured fields, not a measurement, so
// it runs on its own slow cadence and skips entirely when nothing has
// changed. Five minutes bounds the staleness a client can see; the
// unchanged-inputs check is what keeps an idle team free.

const store = new PointGuardStore();
const scheduler = new Scheduler({ store });
const merges = new MergeProcessor({ store, scheduler });

// Plan-owned delegations auto-merge on acceptance (submitting a plan IS the
// approval) — every mechanical/judge gate still re-runs at integration
// unchanged; only the human confirm-merge CLICK is bypassed, and only for
// plan-originated work. Standalone delegate_task calls are untouched.
scheduler.setAutoMergeHook(async (delegationId) => {
  const row = store.getDelegation(delegationId);
  if (!row) return false;
  const enq = await merges.enqueue(delegationId);
  if (!enq.ok) {
    log.warn(`plan auto-merge: enqueue failed for ${delegationId}: ${enq.error}`);
    return false;
  }
  const repoCommon = await commonDir(row.repo);
  const outcome = await merges.processNext(repoCommon, row.target_ref);
  if (outcome.outcome !== "published") {
    log.warn(`plan auto-merge: ${delegationId} did not publish this pass (${outcome.outcome}) — will retry on the next settlement/resume`);
    return false;
  }
  return true;
});

// Recovery BEFORE dispatch resumes (plan: Durable State and Recovery) — no
// replacement worker is launched beside an unaccounted-for one.
const recovered = scheduler.reconcileOnStartup();
await merges.recoverPublishing();

/**
 * The step recovery alone never did: actually push newly-`queued` work
 * forward. `reconcileOnStartup`/`recoverPublishing` correctly RECORD that a
 * delegation/merge needs another pass, but neither one calls `runCycle`/
 * `processNext` — without this, everything sits durably tracked and
 * permanently idle until some unrelated new request happens to nudge it.
 * That's backwards from "resume where it left off".
 *
 * Paced by the scheduler's own concurrency gate: `runCycle` already refuses
 * (returns false) once `inFlight.size >= maxWorkers`, so firing every
 * candidate concurrently and letting that admission control serialize them
 * is sufficient — no separate breaker needed. A delegation that gets `false`
 * here isn't lost; it stays `queued` for the next natural trigger, same as
 * it always has been.
 */
async function resumeQueuedDelegations(): Promise<{ attempted: number; started: number }> {
  const queued = store.listDelegations({ state: "queued" });
  const results = await Promise.all(queued.map((row) => scheduler.runCycle(row.id)));
  const started = results.filter(Boolean).length;
  if (queued.length > 0) {
    log.info(`resume: ${started} of ${queued.length} queued delegation(s) started this pass; ${queued.length - started} deferred to the next tick`);
  }
  return { attempted: queued.length, started };
}

/** One `processNext` call per distinct (repo, targetRef) drains that
 * target's whole queue — it claims-and-serializes internally. Different
 * targets are independent and safe to kick concurrently. */
async function resumeQueuedMerges(): Promise<{ targets: number }> {
  const targets = store.queuedMergeTargets();
  await Promise.all(targets.map((t) => merges.processNext(t.repoCommonDir, t.targetRef)));
  if (targets.length > 0) log.info(`resume: kicked ${targets.length} merge target(s) with queued work`);
  return { targets: targets.length };
}

/**
 * A plan whose delegation was reconciled back to `queued` (Part 1's crash
 * recovery) needs its plan-side settlement callback re-armed too —
 * reconcileOnStartup only knows about delegations, not which plan/step
 * they belong to. Re-running runPlan for every open plan is idempotent
 * (nextRunnableSteps/claimPlanStep guard against re-dispatching anything
 * already in_progress) and picks the requeued delegation back up.
 */
async function resumeOpenPlans(): Promise<{ plans: number }> {
  const open = store.openPlans();
  for (const plan of open) {
    await scheduler.runPlan(plan.id);
  }
  if (open.length > 0) log.info(`resume: re-armed ${open.length} open plan(s)`);
  return { plans: open.length };
}

/** Best-effort cleanup: a worktree left behind by a crashed attempt or
 * integration. Never blocks startup — a repo whose worktree listing fails
 * (unreadable, deleted) is skipped, not fatal. */
async function pruneStartupWorktrees(): Promise<{ pruned: number; retained: number }> {
  let pruned = 0;
  let retained = 0;
  for (const repo of store.activeRepos()) {
    try {
      const keep = store.liveWorktreeSessionIds(repo);
      const result = await pruneOrphanedWorktrees(repo, keep);
      pruned += result.pruned.length;
      retained += result.retained.length;
    } catch (error) {
      log.warn(`worktree prune skipped for ${repo}: ${String(error)}`);
    }
  }
  if (pruned > 0 || retained > 0) log.info(`worktree prune: removed ${pruned}, retained ${retained} (dirty/unreadable)`);
  return { pruned, retained };
}

const resumedDelegations = await resumeQueuedDelegations();
const resumedMerges = await resumeQueuedMerges();
const resumedPlans = await resumeOpenPlans();
const prunedWorktrees = await pruneStartupWorktrees();
const startupRecoveryDone = true;

const app = express();
app.use(express.json({ limit: "2mb" }));

function authorized(req: express.Request): boolean {
  if (!SECRET) return false; // no secret configured = nothing is authorized
  const header = req.headers.authorization;
  if (header === `Bearer ${SECRET}`) return true;
  return req.headers["x-barry-secret"] === SECRET;
}

// Liveness only — no auth, no details, no model tokens (a health probe that
// spends tokens or leaks state is its own incident).
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use((req, res, next) => {
  if (!authorized(req)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
});

app.get("/readiness", (_req, res) => {
  const pendingOutbox = store.pendingOutbox(1).length;
  res.json({
    ok: true,
    startupRecoveryDone,
    reconciledOnStartup: recovered.reconciled,
    integratingRequeuedOnStartup: recovered.integratingRequeued,
    staleMergesReclaimedOnStartup: recovered.staleMergesReclaimed,
    resumedDelegations,
    resumedMerges,
    resumedPlans,
    prunedWorktrees,
    activeWorkers: scheduler.activeWorkerCount(),
    outboxBacklog: pendingOutbox > 0,
    cursor: store.latestCursor(),
    bookSessions: store.bookRows().length,
    // Both null-able on purpose: "never generated" is a real state a
    // diagnosing operator needs to tell from "generated a while ago".
    debriefGeneratedAt: store.debriefSnapshot()?.generatedAt ?? null,
    narrativeGeneratedAt: store.debriefNarrative()?.generatedAt ?? null,
  });
});

/**
 * The manual re-drive trigger (point-guard:resync action wraps this). Useful
 * outside the startup window itself — e.g. after a long dependency outage
 * (a stopped vault, a network partition) where the SERVICE never restarted,
 * so startup recovery never ran again, but work is nonetheless stuck.
 * Returns the same shape /readiness reports, generated fresh, not narrated.
 */
app.post("/admin/resync", async (_req, res) => {
  try {
    const delegationsResumed = await resumeQueuedDelegations();
    const mergesResumed = await resumeQueuedMerges();
    const plansResumed = await resumeOpenPlans();
    const worktreesPruned = await pruneStartupWorktrees();
    res.json({ resumedDelegations: delegationsResumed, resumedMerges: mergesResumed, resumedPlans: plansResumed, prunedWorktrees: worktreesPruned });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post("/delegations", async (req, res) => {
  const { brief } = req.body as { brief?: unknown };
  const result = await scheduler.dispatch(brief);
  if (!result.ok || !result.delegationId) {
    res.status(400).json({ error: result.error });
    return;
  }
  const delegationId = result.delegationId;
  void scheduler
    .runCycle(delegationId)
    .catch((error) => log.error(`cycle ${delegationId}: ${String(error)}`));
  res.status(201).json({ delegationId });
});

app.get("/delegations", (req, res) => {
  const state = typeof req.query.state === "string" ? (req.query.state as never) : undefined;
  res.json({
    delegations: store.listDelegations({ state }).map((d) => ({
      id: d.id,
      state: d.state,
      attempts: d.attempt_count,
      repo: d.repo,
      targetRef: d.target_ref,
      reason: d.reason,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    })),
  });
});

app.get("/delegations/:id", (req, res) => {
  const row = store.getDelegation(req.params.id);
  if (!row) {
    res.status(404).json({ error: "unknown delegation" });
    return;
  }
  res.json({
    delegation: { ...row, brief: JSON.parse(row.brief_json) },
    runs: store.runsForDelegation(row.id),
    ledger: store.ledgerFor(row.id),
  });
});

app.get("/delegations/:id/report", (req, res) => {
  const evidence = store.evidenceFor(req.params.id, "report").at(-1);
  if (!evidence) {
    res.status(404).json({ error: "no report evidence" });
    return;
  }
  res.json({ report: evidence.payload, candidateSha: evidence.candidate_sha });
});

app.get("/delegations/:id/diff", (req, res) => {
  const evidence = store.evidenceFor(req.params.id, "diff").at(-1);
  if (!evidence) {
    res.status(404).json({ error: "no diff evidence" });
    return;
  }
  res.json({ diff: (evidence.payload as { diff: string }).diff });
});

app.get("/delegations/:id/evidence", (req, res) => {
  res.json({ evidence: store.evidenceFor(req.params.id) });
});

app.post("/delegations/:id/cancel", (req, res) => {
  const row = store.getDelegation(req.params.id);
  if (!row) {
    res.status(404).json({ error: "unknown delegation" });
    return;
  }
  if (row.state === "queued" || row.state === "blocked") {
    store.transitionDelegation(row.id, [row.state], "cancelled", "cancelled via API");
    res.json({ cancelled: true });
    return;
  }
  res.status(409).json({ error: `cannot cancel from ${row.state}` });
});

/**
 * The Phase A human gate: publication happens only when the coach confirms.
 * Confirmation does NOT bypass gates — processNext re-verifies the
 * integrated tree before any ref moves.
 */
app.post("/delegations/:id/confirm-merge", async (req, res) => {
  const row = store.getDelegation(req.params.id);
  if (!row) {
    res.status(404).json({ error: "unknown delegation" });
    return;
  }
  try {
    if (row.state === "accepted") {
      const enq = await merges.enqueue(row.id);
      if (!enq.ok) {
        res.status(409).json({ error: enq.error });
        return;
      }
    }
    const repoCommon = await commonDir(row.repo);
    const outcome = await merges.processNext(repoCommon, row.target_ref);
    res.json({ outcome });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

/**
 * Plan intake: validate, freeze the given steps (never rewritten), fan out
 * whatever is runnable now. The submitter (which may be a different
 * session entirely) polls GET /plans/:id for status.
 */
app.post("/plans", async (req, res) => {
  const parsed = PlanSchema.safeParse((req.body as { plan?: unknown }).plan);
  if (!parsed.success) {
    res.status(400).json({ error: `invalid plan: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
    return;
  }
  try {
    const { planId } = await scheduler.intakePlan(parsed.data);
    const { dispatched } = await scheduler.runPlan(planId);
    res.status(201).json({ planId, dispatchedStepIds: dispatched });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get("/plans/:id", (req, res) => {
  const plan = store.getPlan(req.params.id);
  if (!plan) {
    res.status(404).json({ error: "unknown plan" });
    return;
  }
  const steps = store.planSteps(plan.id);
  res.json({
    planId: plan.id,
    repo: plan.repo,
    targetRef: plan.target_ref,
    steps: steps.map((s) => ({
      stepId: s.step_id,
      status: s.status,
      delegationId: s.delegation_id,
      retrospective: s.retrospective_json ? JSON.parse(s.retrospective_json) : null,
    })),
  });
});

app.get("/ledger", (_req, res) => {
  const rows = store.db
    .prepare("SELECT * FROM ledger ORDER BY created_at DESC LIMIT 200")
    .all();
  res.json({ ledger: rows });
});

/**
 * The structured, no-LLM view of every Barry session point-guard is
 * currently watching -- what the client apps (web/macOS/iOS) visualize.
 * Recomputed on its own interval below; this route only ever reads the
 * cache, it never triggers a fresh tick (a slow client hitting /book
 * repeatedly must not turn into extra lock-db/Postgres load).
 */
app.get("/book", (_req, res) => {
  res.json({ sessions: store.bookRows() });
});

/**
 * The debrief: the whole team's state in one object, for a client to render.
 * Reads the cache only -- never computes, never calls a model. Four clients
 * poll; computing here would multiply every poll into Postgres reads, git
 * calls and model calls.
 *
 * 503 when no tick has produced one yet, rather than an empty debrief: "the
 * service just started" and "there are no sessions" are different states and
 * a client must be able to tell them apart.
 */
app.get("/debrief", (_req, res) => {
  const snapshot = store.debriefSnapshot();
  if (!snapshot) {
    res.status(503).json({ error: "no debrief generated yet" });
    return;
  }
  res.json({ debrief: JSON.parse(snapshot.payloadJson) });
});

app.post("/questions/:id/answer", (req, res) => {
  const { answer } = req.body as { answer?: string };
  if (!answer) {
    res.status(400).json({ error: "answer required" });
    return;
  }
  const info = store.db
    .prepare("UPDATE questions SET answer = ?, answered_at = ? WHERE id = ? AND answer IS NULL")
    .run(answer, store.now(), req.params.id);
  if (info.changes !== 1) {
    res.status(409).json({ error: "question unknown or already answered" });
    return;
  }
  store.emitEvent("question.answered", { id: req.params.id });
  res.json({ answered: true });
});

app.get("/events", (req, res) => {
  const after = Number(req.query.after ?? 0);
  res.json({ events: store.eventsAfter(Number.isFinite(after) ? after : 0), latest: store.latestCursor() });
});

/**
 * The Heartbeat pattern: one message in, one fresh-context reply out, no
 * chaining. Every call is independent -- a second POST /message never sees
 * the first call's content, only whatever the book/events look like NOW.
 */
app.post("/message", async (req, res) => {
  const { content } = req.body as { content?: string };
  if (!content || typeof content !== "string") {
    res.status(400).json({ error: "content required" });
    return;
  }
  const result = await handleMessage(store, content);
  if (!result.ok) {
    res.status(503).json({ error: result.error });
    return;
  }
  res.json({ reply: result.reply });
});

app.get("/message/history", (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  res.json({ messages: store.recentMessageLog(Number.isFinite(limit) ? limit : 50) });
});

// WS stream: cursor-addressed replay + live push, deduped by event id.

const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const liveSockets = new Set<WebSocket>();

httpServer.on("upgrade", (request, socket, head) => {
  const header = request.headers.authorization;
  const alt = request.headers["x-barry-secret"];
  if (!SECRET || (header !== `Bearer ${SECRET}` && alt !== SECRET)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws) => {
  liveSockets.add(ws);
  let alive = true;
  ws.on("pong", () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, HEARTBEAT_MS);

  // Snapshot carries its cursor so the client can replay-from without a
  // snapshot/live race.
  ws.send(JSON.stringify({ type: "hello", cursor: store.latestCursor() }));

  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(String(raw)) as { type?: string; after?: number };
      if (message.type === "replay") {
        for (const event of store.eventsAfter(message.after ?? 0)) {
          ws.send(JSON.stringify({ type: "event", event }));
        }
      }
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "bad message" }));
    }
  });

  ws.on("close", () => {
    clearInterval(heartbeat);
    liveSockets.delete(ws);
  });
});

// Live push: poll the durable stream (the WAL write is the source of truth;
// push is a latency optimization, so the poller reads the same table clients
// replay from — one code path, no dual-write skew).
let pushCursor = store.latestCursor();
setInterval(() => {
  const events = store.eventsAfter(pushCursor, 200);
  if (events.length === 0) return;
  pushCursor = events[events.length - 1].cursor;
  const frames = events.map((e) => JSON.stringify({ type: "event", event: e }));
  for (const ws of liveSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      for (const frame of frames) ws.send(frame);
    }
  }
}, 500);

// Outbox flusher + periodic reconciliation

async function flushOutbox(): Promise<void> {
  for (const entry of store.pendingOutbox(20)) {
    if (entry.kind !== "barry-event") {
      // Visibility rows (session-create-failed etc.): recorded, surfaced via
      // readiness, no external delivery to attempt.
      if (entry.attempts === 0) store.markOutboxFailed(entry.id, "visibility-only row");
      continue;
    }
    try {
      const apiPort = process.env.BARRY_API_PORT ?? "3854";
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/v1/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${SECRET}`,
        },
        body: JSON.stringify(entry.payload),
      });
      if (response.ok) {
        store.markOutboxDelivered(entry.id);
      } else {
        store.markOutboxFailed(entry.id, `api ${response.status}`);
      }
    } catch (error) {
      store.markOutboxFailed(entry.id, String(error));
    }
  }
}
setInterval(() => void flushOutbox(), OUTBOX_INTERVAL_MS);

setInterval(() => {
  // The 300s sweep: re-run recovery invariants while alive (child death is
  // handled by the runner; this catches anything that slipped).
  try {
    scheduler.reconcileOnStartup();
  } catch (error) {
    log.error(`reconcile sweep: ${String(error)}`);
  }
}, RECONCILE_INTERVAL_MS);

// ---------------------------------------------------------------------------
// The book: a periodic supervisor tick, independent of the delegation
// pipeline's own recovery sweep above. A failed tick logs and skips -- the
// book simply keeps last tick's cache until the next one succeeds, per
// supervisor.ts's own fail-open contract for a lock-db read problem.
//
// Notification fires on a TRANSITION into a flagged state, not on every
// tick a session stays flagged -- otherwise a session stuck for an hour
// would notify once a minute for the whole hour. `previouslyFlagged`
// tracks what the LAST tick already knew about, entirely in-process (this
// is deliberately not persisted; a service restart re-notifying once for
// a still-flagged session is the acceptable failure mode, not silence).
// ---------------------------------------------------------------------------

let previouslyFlagged = new Set<string>();

function notifyNewFlags(): void {
  const rows = store.bookRows();
  const currentlyFlagged = new Set(rows.filter((r) => r.status !== "ok").map((r) => r.sessionId));

  for (const row of rows) {
    if (row.status === "ok" || previouslyFlagged.has(row.sessionId)) continue;
    const eventType = row.status === "stuck" ? "session_stuck" : "conflict_detected";
    store.emitEvent(eventType, { sessionId: row.sessionId, reason: row.flaggedReason, repo: row.repo });
    const result = notify(`point-guard: session ${row.sessionId.slice(0, 12)} is ${row.status} -- ${row.flaggedReason ?? "no reason given"}`);
    if (!result.ok) log.warn(`notify failed for ${row.sessionId}: ${result.error}`);
  }

  previouslyFlagged = currentlyFlagged;
}

async function tickSupervisor(): Promise<void> {
  try {
    const result = await runSupervisorTick(store);
    if (result.conflicted > 0 || result.stuck > 0 || result.pruned > 0) {
      log.info(`book: ${result.observed} observed, ${result.conflicted} conflicted, ${result.stuck} stuck, ${result.pruned} pruned`);
    }
    notifyNewFlags();
  } catch (error) {
    log.error(`supervisor tick failed: ${String(error)}`);
  }
}
void tickSupervisor(); // don't leave /book empty for a full interval after a fresh start
setInterval(() => void tickSupervisor(), SUPERVISOR_TICK_INTERVAL_MS);

/**
 * The merge-tree backstop: a slower, more expensive pass than the main
 * tick above. Runs independently -- a failure here must not affect the
 * main tick's own book rows for anything the real-time tier already
 * covers. tickSupervisor's own notifyNewFlags() call also covers
 * escalations this pass makes (recordMergeTreeCheck's escalateStatus
 * writes straight to the book, and the NEXT main tick's notifyNewFlags
 * picks up the transition) -- this function does not duplicate that
 * notification path itself.
 */
async function tickMergeTreeBackstop(): Promise<void> {
  try {
    const result = await runMergeTreeBackstop(store, (worktree) => resolveSha(worktree, "HEAD"));
    if (result.conflictsFound > 0) {
      log.info(`merge-tree backstop: ${result.groupsChecked} group(s), ${result.pairsChecked} pair(s), ${result.conflictsFound} conflict(s)`);
    }
  } catch (error) {
    log.error(`merge-tree backstop failed: ${String(error)}`);
  }
}
setInterval(() => void tickMergeTreeBackstop(), MERGE_TREE_BACKSTOP_INTERVAL_MS);

/**
 * The narrative pass. Advisory only: a failure here leaves the previous
 * narrative in place and never touches the structured snapshot, which is
 * already durable from the supervisor tick.
 *
 * Skips the model call entirely when the inputs hash is unchanged, so an
 * idle team costs nothing rather than a call every five minutes forever.
 */
async function tickNarrative(): Promise<void> {
  try {
    const snapshot = store.debriefSnapshot();
    if (!snapshot) return; // no debrief yet; nothing to describe
    const debrief = JSON.parse(snapshot.payloadJson) as Debrief;
    const cached = store.debriefNarrative();
    if (!shouldRegenerate(debrief, cached ? { ...cached, text: cached.text } : null)) return;

    const narrative = await generateNarrative(debrief);
    if (!narrative) return; // degraded: keep whatever we had
    store.putDebriefNarrative(narrative.text, narrative.model, narrative.inputsHash);
    log.info(`debrief narrative regenerated (${narrative.model})`);
  } catch (error) {
    log.warn(`narrative tick failed: ${String(error)}`);
  }
}
setInterval(() => void tickNarrative(), NARRATIVE_INTERVAL_MS);

httpServer.listen(PORT, "127.0.0.1", () => {
  log.info(`point-guard listening on 127.0.0.1:${PORT}`);
});
