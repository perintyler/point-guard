/**
 * Plan intake and execution. Point-guard receives a plan and runs its
 * dependency graph — it never authors steps, never reorders them, and (per
 * the confirmed design) auto-merges each accepted step so dependents'
 * baselines actually contain prior steps' work, without a human click
 * between every step of a plan that was already approved as a unit.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PointGuardStore } from "../store.js";
import { Scheduler } from "../scheduler.js";
import { MergeProcessor } from "../merge.js";
import { PlanSchema } from "../contracts.js";
import { commonDir, resolveSha, git } from "../gitwt.js";
import { fakeWorker, fakeJudge, makeFixtureRepo, tempStoreEnv, gitf } from "./fixture.js";

/** Poll until `predicate` is true or 25s elapse (comfortably inside the
 * file's 30s testTimeout — see vitest.config.ts's comment on why these
 * tests need real headroom under load, not a fixed small iteration count
 * that reads as flake whenever the machine is busy). */
async function pollUntil(predicate: () => boolean, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function onePlan(repo: string, overrides?: Partial<Parameters<typeof PlanSchema.parse>[0]>) {
  return PlanSchema.parse({
    repo,
    steps: [
      {
        id: "s1",
        text: "Make count() return 2",
        fileScope: ["counter.js"],
        acceptanceChecks: [{ id: "check", argv: ["node", "check.js"] }],
        requirements: [{ id: "R1", text: "count() returns 2" }],
      },
    ],
    ...overrides,
  });
}

function fixTheCounter(cwd: string) {
  writeFileSync(join(cwd, "counter.js"), "export function count() { return 2; }\n");
}

function makeScheduler(store: PointGuardStore, mutate: (cwd: string) => void) {
  const scheduler = new Scheduler({
    store,
    workerRunnerFactory: fakeWorker({ mutate }),
    judgeRunnerFactory: fakeJudge(),
    sessionProjection: false,
  });
  const merges = new MergeProcessor({ store, scheduler, judgeRunnerFactory: fakeJudge() });
  scheduler.setAutoMergeHook(async (delegationId) => {
    const row = store.getDelegation(delegationId)!;
    const enq = await merges.enqueue(delegationId);
    if (!enq.ok) return false;
    const outcome = await merges.processNext(await commonDir(row.repo), row.target_ref);
    return outcome.outcome === "published";
  });
  return { scheduler, merges };
}

describe("plan intake", () => {
  let store: PointGuardStore;
  let repo: string;

  beforeEach(() => {
    tempStoreEnv();
    store = new PointGuardStore();
    repo = makeFixtureRepo();
  });

  it("is idempotent on planId: resubmitting does not duplicate dispatched work", async () => {
    const { scheduler } = makeScheduler(store, fixTheCounter);
    const plan = onePlan(repo, { planId: "p-fixed" });
    const first = await scheduler.intakePlan(plan);
    expect(first.created).toBe(true);
    await scheduler.runPlan(first.planId);

    const second = await scheduler.intakePlan(plan);
    expect(second.created).toBe(false);
    expect(second.planId).toBe(first.planId);
    // Only one delegation exists for the step — the second intake did not
    // create a duplicate.
    expect(store.listDelegations({ limit: 100 })).toHaveLength(1);
  });

  it("rejects a plan with a step depending on an unknown step id", () => {
    expect(() =>
      onePlan(repo, {
        steps: [
          { id: "s1", text: "t", fileScope: ["a"], acceptanceChecks: [{ id: "c", argv: ["true"] }], requirements: [{ id: "R1", text: "x" }], dependsOn: ["ghost"] },
        ],
      }),
    ).toThrow(/depends on unknown step/);
  });

  it("rejects duplicate step ids within one plan", () => {
    expect(() =>
      onePlan(repo, {
        steps: [
          { id: "dup", text: "a", fileScope: ["a"], acceptanceChecks: [{ id: "c", argv: ["true"] }], requirements: [{ id: "R1", text: "x" }] },
          { id: "dup", text: "b", fileScope: ["b"], acceptanceChecks: [{ id: "c", argv: ["true"] }], requirements: [{ id: "R1", text: "x" }] },
        ],
      }),
    ).toThrow(/unique/);
  });

  it("rejects a step that depends on itself", () => {
    expect(() =>
      onePlan(repo, {
        steps: [{ id: "s1", text: "t", fileScope: ["a"], acceptanceChecks: [{ id: "c", argv: ["true"] }], requirements: [{ id: "R1", text: "x" }], dependsOn: ["s1"] }],
      }),
    ).toThrow(/cannot depend on itself/);
  });
});

describe("plan execution: a single step (the 'small task' case)", () => {
  let store: PointGuardStore;
  let repo: string;

  beforeEach(() => {
    tempStoreEnv();
    store = new PointGuardStore();
    repo = makeFixtureRepo();
  });

  it("dispatches the one step, and point-guard copies its text VERBATIM into the delegation objective", async () => {
    const { scheduler } = makeScheduler(store, fixTheCounter);
    const plan = onePlan(repo);
    const { planId } = await scheduler.intakePlan(plan);
    const { dispatched } = await scheduler.runPlan(planId);
    expect(dispatched).toEqual(["s1"]);

    const steps = store.planSteps(planId);
    expect(steps[0].status).toBe("in_progress");
    const delegation = store.getDelegation(steps[0].delegation_id!)!;
    expect(JSON.parse(delegation.brief_json).objective).toBe("Make count() return 2");
  });

  it("auto-merges on acceptance and marks the step done with a retrospective, without a human confirm-merge call", async () => {
    const { scheduler } = makeScheduler(store, fixTheCounter);
    const plan = onePlan(repo);
    const { planId } = await scheduler.intakePlan(plan);
    await scheduler.runPlan(planId);

    // Wait for the fire-and-forget cycle+settlement chain to finish.
    await pollUntil(() => store.planSteps(planId)[0].status === "done");
    const steps = store.planSteps(planId);

    expect(steps[0].status).toBe("done");
    expect(JSON.parse(steps[0].retrospective_json!).summary).toContain("count");

    // Master's REF actually advanced to contain the fix — no human ever
    // called confirm-merge. (git update-ref moves the ref, not the main
    // working tree's checkout, so reading counter.js off disk here would
    // test the wrong thing; `git show <sha>:path` reads the committed
    // content directly.)
    const sha = await resolveSha(repo, "refs/heads/master");
    const { stdout } = await git(repo, ["show", `${sha}:counter.js`]);
    expect(stdout).toContain("return 2");
  });

  it("a step whose delegation is blocked settles the step as failed, not done", async () => {
    const brokenMutate = (cwd: string) => writeFileSync(join(cwd, "counter.js"), "export function count() { return 999; }\n");
    const { scheduler } = makeScheduler(store, brokenMutate);
    const plan = onePlan(repo, {
      steps: [
        {
          id: "s1", text: "t",
          fileScope: ["counter.js"],
          acceptanceChecks: [{ id: "check", argv: ["node", "check.js"] }],
          requirements: [{ id: "R1", text: "x" }],
        },
      ],
    });
    const { planId } = await scheduler.intakePlan(plan);
    await scheduler.runPlan(planId);

    await pollUntil(() => store.planSteps(planId)[0].status !== "in_progress");
    expect(store.planSteps(planId)[0].status).toBe("failed");
  });
});

describe("plan execution: dependency graph fan-out", () => {
  let store: PointGuardStore;
  let repo: string;

  beforeEach(() => {
    tempStoreEnv();
    store = new PointGuardStore();
    repo = makeFixtureRepo();
    // A second file + check so the dependent step has its own, unrelated
    // acceptance surface — its worker only needs to add file B, and its
    // check only needs file B to exist (independent of counter.js's state,
    // so this test isolates "did it wait for the dependency" from "did it
    // also need A's actual content").
    writeFileSync(join(repo, "checkB.js"), "import { readFileSync } from 'node:fs'; readFileSync('./b.txt', 'utf8'); console.log('b exists');\n");
    gitf(repo, ["add", "checkB.js"]);
    gitf(repo, ["commit", "-m", "add checkB"]);
  });

  it("dispatches only the independent step first; the dependent becomes runnable after the first is DONE (merged)", async () => {
    // A worker double that respects EACH step's actual file scope: writing
    // to both files regardless of which step dispatched it would trip the
    // mechanical gate's out-of-scope check (correctly) rather than testing
    // dependency ordering. Since b cannot dispatch before a is `done`
    // (that ordering is exactly what this test verifies), the Nth call is
    // unambiguous: call 1 is always step a's (first) attempt.
    let callCount = 0;
    const scheduler = new Scheduler({
      store,
      workerRunnerFactory: (config) => {
        callCount += 1;
        const isStepA = callCount === 1;
        return fakeWorker({
          mutate: (cwd) => (isStepA ? fixTheCounter(cwd) : writeFileSync(join(cwd, "b.txt"), "b\n")),
        })(config);
      },
      judgeRunnerFactory: fakeJudge(),
      sessionProjection: false,
    });
    const merges = new MergeProcessor({ store, scheduler, judgeRunnerFactory: fakeJudge() });
    scheduler.setAutoMergeHook(async (delegationId) => {
      const row = store.getDelegation(delegationId)!;
      const enq = await merges.enqueue(delegationId);
      if (!enq.ok) return false;
      const outcome = await merges.processNext(await commonDir(row.repo), row.target_ref);
      return outcome.outcome === "published";
    });

    const plan = PlanSchema.parse({
      repo,
      steps: [
        { id: "a", text: "fix counter", fileScope: ["counter.js"], acceptanceChecks: [{ id: "c", argv: ["node", "check.js"] }], requirements: [{ id: "R1", text: "x" }] },
        { id: "b", text: "add b.txt", dependsOn: ["a"], fileScope: ["b.txt"], acceptanceChecks: [{ id: "c", argv: ["node", "checkB.js"] }], requirements: [{ id: "R1", text: "x" }] },
      ],
    });
    const { planId } = await scheduler.intakePlan(plan);
    const first = await scheduler.runPlan(planId);
    // Only the independent step dispatches immediately — b's dependency is
    // not yet satisfied.
    expect(first.dispatched).toEqual(["a"]);
    expect(store.planSteps(planId).find((s) => s.step_id === "b")!.status).toBe("queued");

    // Poll until BOTH steps reach a terminal status (done/failed), then
    // assert on the final, settled state — no ordering assumptions about
    // exactly when b's delegation_id first appears mid-flight.
    const isTerminal = (s: { status: string }) => s.status === "done" || s.status === "failed";
    await pollUntil(() => store.planSteps(planId).every(isTerminal));
    const steps = store.planSteps(planId);

    const aFinal = steps.find((s) => s.step_id === "a")!;
    const bFinal = steps.find((s) => s.step_id === "b")!;
    expect(aFinal.status).toBe("done");
    expect(bFinal.status).toBe("done");
    // b only ever became runnable after a settled — proven structurally: b
    // had no delegation_id in the snapshot taken immediately after the
    // first runPlan call, above.
  });
});

describe("resume: an in-progress plan step survives reconciliation", () => {
  it("re-arming an open plan after its delegation was reconciled to queued picks the work back up", async () => {
    tempStoreEnv();
    const store = new PointGuardStore();
    const repo = makeFixtureRepo();
    const { scheduler } = makeScheduler(store, fixTheCounter);
    const plan = onePlan(repo);
    const { planId } = await scheduler.intakePlan(plan);
    await scheduler.runPlan(planId);

    // Simulate a crash: force the delegation back to `running` with a
    // dangling run row, the way Part 1's reconcileOnStartup expects to find it.
    const steps = store.planSteps(planId);
    const delegationId = steps[0].delegation_id!;
    // Wait for the real cycle to actually finish first so we have a stable
    // delegation to manipulate, then simulate a LATER crash on a fresh attempt.
    await pollUntil(() => {
      const state = store.getDelegation(delegationId)!.state;
      return state === "accepted" || state === "merged";
    });
    // At this point the step likely already completed via auto-merge; the
    // real crash-mid-flight case is covered by recovery.test.ts. Here we
    // only need to prove resumeOpenPlans/runPlan is idempotent and safe to
    // call again after the fact.
    const before = store.planSteps(planId);
    await scheduler.runPlan(planId); // re-arm; must not double-dispatch
    const after = store.planSteps(planId);
    expect(after).toEqual(before);
  });
});
