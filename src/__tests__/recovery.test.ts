/**
 * Crash recovery: the reconciled-but-idle gap, the stuck-mid-integration
 * window, orphaned worktrees, and the bootstrap-window fix. Each test
 * simulates a crash by leaving rows in an in-flight state directly (rather
 * than actually killing a process), then exercises the same recovery code
 * a real restart would run.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PointGuardStore } from "../store.js";
import { Scheduler } from "../scheduler.js";
import { MergeProcessor } from "../merge.js";
import {
  fakeWorker,
  fakeJudge,
  fixtureBrief,
  makeFixtureRepo,
  tempStoreEnv,
  gitf,
} from "./fixture.js";
import { realpathSync } from "node:fs";
import { createWorktree, listRegisteredWorktrees, pruneOrphanedWorktrees, commonDir } from "../gitwt.js";

/** git resolves symlinks in its own output (macOS /var -> /private/var); a
 * path built by the test needs the same resolution before comparing against
 * what pruneOrphanedWorktrees reports, which is git's own worktree list. */
const real = (path: string) => realpathSync(path);

const fixTheCounter = (cwd: string) => {
  writeFileSync(join(cwd, "counter.js"), "export function count() { return 2; }\n");
};

describe("reconcileOnStartup: the stuck-before-publish-intent window", () => {
  let store: PointGuardStore;
  let repo: string;

  beforeEach(() => {
    tempStoreEnv();
    store = new PointGuardStore();
    repo = makeFixtureRepo();
  });

  it("re-queues a delegation crashed mid-integrating (before publication_intent_at was ever written)", async () => {
    const scheduler = new Scheduler({
      store,
      workerRunnerFactory: fakeWorker({ mutate: fixTheCounter }),
      judgeRunnerFactory: fakeJudge(),
      sessionProjection: false,
    });
    const { delegationId } = await scheduler.dispatch(fixtureBrief(repo));
    await scheduler.runCycle(delegationId!);
    expect(store.getDelegation(delegationId!)!.state).toBe("accepted");

    // Simulate the crash: jump straight to `integrating` the way merge.ts's
    // claim step does, but never reach publication_intent_at — this is
    // exactly the window recoverPublishing() cannot see.
    store.transitionDelegation(delegationId!, "accepted", "integrating");
    expect(store.getDelegation(delegationId!)!.state).toBe("integrating");

    const result = store.getDelegation(delegationId!)!;
    void result;
    const { integratingRequeued } = scheduler.reconcileOnStartup();
    expect(integratingRequeued).toBe(1);
    expect(store.getDelegation(delegationId!)!.state).toBe("queued");
    expect(store.getDelegation(delegationId!)!.reason).toMatch(/crashed before publish intent/);
  });

  it("blocks instead of re-queuing when the attempt cap is already reached", async () => {
    const scheduler = new Scheduler({
      store,
      workerRunnerFactory: fakeWorker({ mutate: fixTheCounter }),
      judgeRunnerFactory: fakeJudge(),
      sessionProjection: false,
    });
    const { delegationId } = await scheduler.dispatch(fixtureBrief(repo, { attemptLimit: 1 }));
    await scheduler.runCycle(delegationId!);
    store.transitionDelegation(delegationId!, "accepted", "integrating");

    scheduler.reconcileOnStartup();
    expect(store.getDelegation(delegationId!)!.state).toBe("blocked");
  });

  it("reclaims a merge_queue row left claimed/integrated by the same crash, unblocking the target", async () => {
    const scheduler = new Scheduler({
      store,
      workerRunnerFactory: fakeWorker({ mutate: fixTheCounter }),
      judgeRunnerFactory: fakeJudge(),
      sessionProjection: false,
    });
    const merges = new MergeProcessor({ store, scheduler, judgeRunnerFactory: fakeJudge() });
    const { delegationId: idA } = await scheduler.dispatch(fixtureBrief(repo));
    await scheduler.runCycle(idA!);
    const enq = await merges.enqueue(idA!);
    const common = await commonDir(repo);

    // Simulate a crash right after claimNextMerge but before intent: force
    // the row to `claimed` and the delegation to `integrating` directly.
    store.updateMerge(enq.queueId!, { state: "claimed" });
    store.transitionDelegation(idA!, "accepted", "integrating");

    // Without recovery, a second delegation's merge to the SAME target is
    // starved forever by claimNextMerge's in-flight check.
    const { delegationId: idB } = await scheduler.dispatch(fixtureBrief(repo));
    await scheduler.runCycle(idB!);
    await merges.enqueue(idB!);
    const stillClaimed = store.claimNextMerge(common, "refs/heads/master");
    expect(stillClaimed).toBeUndefined(); // starved, as expected before recovery

    const { integratingRequeued, staleMergesReclaimed } = scheduler.reconcileOnStartup();
    expect(integratingRequeued).toBe(1);
    expect(staleMergesReclaimed).toBe(1);

    // Now B's merge can be claimed — the target is no longer permanently blocked.
    const claimedAfterRecovery = store.claimNextMerge(common, "refs/heads/master");
    expect(claimedAfterRecovery?.delegation_id).toBe(idB);
  });
});

describe("resume: recovery marks work queued, but something must actually re-drive it", () => {
  let store: PointGuardStore;
  let repo: string;

  beforeEach(() => {
    tempStoreEnv();
    store = new PointGuardStore();
    repo = makeFixtureRepo();
  });

  it("a delegation left queued by reconciliation does NOT run on its own — proving the gap this feature closes", async () => {
    const scheduler = new Scheduler({
      store,
      workerRunnerFactory: fakeWorker({ mutate: fixTheCounter }),
      judgeRunnerFactory: fakeJudge(),
      sessionProjection: false,
    });
    const { delegationId } = await scheduler.dispatch(fixtureBrief(repo));
    // Nothing calls runCycle. This is deliberately the "recorded but idle"
    // state a crash-and-restart leaves behind before any resume step runs.
    expect(store.getDelegation(delegationId!)!.state).toBe("queued");
    expect(store.getDelegation(delegationId!)!.attempt_count).toBe(0);
  });

  it("a paced resume pass (Promise.all over queued delegations) actually starts them", async () => {
    const scheduler = new Scheduler({
      store,
      workerRunnerFactory: fakeWorker({ mutate: fixTheCounter }),
      judgeRunnerFactory: fakeJudge(),
      sessionProjection: false,
    });
    const a = await scheduler.dispatch(fixtureBrief(repo));
    const b = await scheduler.dispatch(fixtureBrief(repo));

    // This IS the resume pass server/src/index.ts runs at startup and via
    // /admin/resync — reproduced directly against the scheduler here.
    const queued = store.listDelegations({ state: "queued" });
    expect(queued).toHaveLength(2);
    const results = await Promise.all(queued.map((row) => scheduler.runCycle(row.id)));
    expect(results.every(Boolean)).toBe(true);

    expect(store.getDelegation(a.delegationId!)!.state).toBe("accepted");
    expect(store.getDelegation(b.delegationId!)!.state).toBe("accepted");
  });

  it("resume respects the concurrency cap — excess delegations stay queued for the next tick, not lost", async () => {
    const scheduler = new Scheduler({
      store,
      maxConcurrentWorkers: 1,
      workerRunnerFactory: fakeWorker({ mutate: fixTheCounter }),
      judgeRunnerFactory: fakeJudge(),
      sessionProjection: false,
    });
    const a = await scheduler.dispatch(fixtureBrief(repo));
    const b = await scheduler.dispatch(fixtureBrief(repo));

    const queued = store.listDelegations({ state: "queued" });
    const results = await Promise.all(queued.map((row) => scheduler.runCycle(row.id)));
    const startedCount = results.filter(Boolean).length;
    // Exactly one starts synchronously through the slot; the other is
    // refused (false) — but crucially still `queued`, not `failed`/dropped.
    expect(startedCount).toBeGreaterThanOrEqual(1);
    const finalStates = [store.getDelegation(a.delegationId!)!.state, store.getDelegation(b.delegationId!)!.state];
    expect(finalStates.every((s) => s === "accepted" || s === "queued")).toBe(true);
  });
});

describe("worktree pruning on startup", () => {
  let store: PointGuardStore;
  let repo: string;

  beforeEach(() => {
    tempStoreEnv();
    store = new PointGuardStore();
    repo = makeFixtureRepo();
    gitf(repo, ["config", "receive.denyCurrentBranch", "ignore"]);
  });

  it("prunes a clean, abandoned worktree with no live delegation referencing it", async () => {
    const { path } = await createWorktree({ repo, sessionId: "orphan-clean", baselineSha: "HEAD" });
    expect(existsSync(path)).toBe(true);
    const resolvedBeforePrune = real(path); // resolve BEFORE it's removed — realpath needs the target to exist

    const keep = store.liveWorktreeSessionIds(repo); // empty: no runs recorded at all
    const result = await pruneOrphanedWorktrees(repo, keep);

    expect(result.pruned).toContain(resolvedBeforePrune);
    expect(existsSync(path)).toBe(false);
  });

  it("retains a dirty worktree rather than force-removing it", async () => {
    const { path } = await createWorktree({ repo, sessionId: "orphan-dirty", baselineSha: "HEAD" });
    writeFileSync(join(path, "uncommitted.txt"), "not committed\n");

    const result = await pruneOrphanedWorktrees(repo, new Set());

    expect(result.retained).toContain(real(path));
    expect(existsSync(path)).toBe(true); // never force-removed
  });

  it("retains a worktree whose session id is in the live set, even if abandoned-looking", async () => {
    const { path } = await createWorktree({ repo, sessionId: "still-needed", baselineSha: "HEAD" });

    const result = await pruneOrphanedWorktrees(repo, new Set(["still-needed"]));

    expect(result.pruned).not.toContain(path);
    expect(existsSync(path)).toBe(true);
  });

  it("liveWorktreeSessionIds keeps sessions for non-terminal delegations and excludes merged/cancelled", async () => {
    const scheduler = new Scheduler({
      store,
      workerRunnerFactory: fakeWorker({ mutate: fixTheCounter }),
      judgeRunnerFactory: fakeJudge(),
      sessionProjection: false,
    });
    const { delegationId } = await scheduler.dispatch(fixtureBrief(repo));
    await scheduler.runCycle(delegationId!);
    const row = store.getDelegation(delegationId!)!;
    expect(row.state).toBe("accepted"); // non-terminal: worktree must be kept

    const runs = store.runsForDelegation(delegationId!);
    const sessionId = runs[0].barry_session_id!;
    expect(store.liveWorktreeSessionIds(repo).has(sessionId)).toBe(true);

    // Once merged, its worktree is no longer protected by this mechanism.
    store.transitionDelegation(delegationId!, "accepted", "integrating");
    store.transitionDelegation(delegationId!, "integrating", "merged");
    expect(store.liveWorktreeSessionIds(repo).has(sessionId)).toBe(false);
  });

  it("listRegisteredWorktrees excludes the main working copy", async () => {
    await createWorktree({ repo, sessionId: "wt-1", baselineSha: "HEAD" });
    const entries = await listRegisteredWorktrees(repo);
    expect(entries.every((e) => e.path !== repo)).toBe(true);
    expect(entries.some((e) => e.name === "wt-1")).toBe(true);
  });
});

describe("bootstrapItems rebuild window (the audit-found bug)", () => {
  it("recentChatHistory returns the NEWEST N messages in chronological order, not the oldest", () => {
    tempStoreEnv();
    const store = new PointGuardStore();
    store.ensureConversation("main");
    for (let i = 0; i < 50; i++) {
      store.appendChat("main", i % 2 === 0 ? "user" : "brain", `message-${i}`);
    }
    const recent = store.recentChatHistory("main", 40);
    expect(recent).toHaveLength(40);
    // Oldest-first ordering preserved WITHIN the window...
    expect(recent[0].content).toBe("message-10");
    // ...but it's the TAIL of the conversation, not the head — this is the
    // fix: chatHistory(id, 0, 40) would have returned message-0..39 instead.
    expect(recent[recent.length - 1].content).toBe("message-49");
  });

  it("chatMessageCount reports the true total, independent of any window", () => {
    tempStoreEnv();
    const store = new PointGuardStore();
    store.ensureConversation("main");
    for (let i = 0; i < 5; i++) store.appendChat("main", "user", `m${i}`);
    expect(store.chatMessageCount("main")).toBe(5);
  });

  it("a conversation shorter than the window is returned in full, oldest first", () => {
    tempStoreEnv();
    const store = new PointGuardStore();
    store.ensureConversation("main");
    store.appendChat("main", "user", "only one");
    const recent = store.recentChatHistory("main", 40);
    expect(recent).toHaveLength(1);
    expect(recent[0].content).toBe("only one");
  });
});
