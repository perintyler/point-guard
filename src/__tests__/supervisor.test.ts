/**
 * The supervisor tick: recomputes the book from (mocked) sessions/messages,
 * lock contention, tool-call history, and file ownership. Real I/O for all
 * four is mocked -- this tests the aggregation/verdict logic point-guard
 * owns, not the correctness of the packages it reads through (those have
 * their own tests).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PointGuardStore } from "../store.js";
import { tempStoreEnv } from "./fixture.js";

const h = vi.hoisted(() => ({
  sessions: [] as Array<{ id: string; metadata: Record<string, unknown> }>,
  activity: new Map<string, { hasMessages: boolean; lastMessageAt: string | null }>(),
  filesBySession: new Map<string, string[]>(),
  repoRootByDir: new Map<string, string>(),
  contendedByRoot: new Map<string, Array<{ repoRoot: string; relPath: string; holder: { session_id: string } | undefined; waiters: Array<{ session_id: string }> }>>(),
  toolCallsBySession: new Map<string, Array<{ name: string; input: unknown; result: unknown; createdAt: string }>>(),
}));

vi.mock("@barry-rocks/db", () => ({
  getActiveSessions: vi.fn(async () => h.sessions),
  getLatestActivityBySessions: vi.fn(async (ids: string[]) => {
    const m = new Map();
    for (const id of ids) if (h.activity.has(id)) m.set(id, h.activity.get(id));
    return m;
  }),
  getRecentToolCallsBySessions: vi.fn(async (ids: string[]) => {
    const m = new Map();
    for (const id of ids) if (h.toolCallsBySession.has(id)) m.set(id, h.toolCallsBySession.get(id));
    return m;
  }),
  // Used by buildDebrief. Mirrors the real precedence rather than returning a
  // constant, so a test asserting on a session's displayed name is testing
  // the same fallback chain production uses.
  getName: (session: { id: string; system_prompt?: string | null; metadata: Record<string, unknown> }) =>
    (session.metadata?.name as string) || session.system_prompt?.slice(0, 50) || session.id.slice(0, 8),
}));

// The debrief reaches the plans service over HTTP. Stubbed to "answered, and
// had none" so the tick's debrief half runs to completion in tests; the
// could-not-ask path has its own coverage in debrief.test.ts.
vi.mock("../debrief-plans.js", () => ({
  fetchOpenPlans: vi.fn(async () => ({ plans: [], error: null, baseUrl: "http://plans.test" })),
  remoteSlugFor: vi.fn(async () => null),
}));

vi.mock("@barry-rocks/locks-bag/db", () => ({
  getDb: vi.fn(() => ({})),
  contendedPaths: vi.fn((_db: unknown, repoRoot?: string) => h.contendedByRoot.get(repoRoot ?? "") ?? []),
}));

vi.mock("@barry-rocks/file-tracker", () => ({
  getDistinctFilesForSessions: vi.fn((ids: string[]) => {
    const m = new Map();
    for (const id of ids) if (h.filesBySession.has(id)) m.set(id, h.filesBySession.get(id));
    return m;
  }),
}));

vi.mock("../gitwt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gitwt.js")>();
  return {
    ...actual,
    commonDir: vi.fn(async (dir: string) => {
      const root = h.repoRootByDir.get(dir);
      if (!root) throw new Error(`not a git repo: ${dir}`);
      return root;
    }),
  };
});

// Imported after the mocks so it picks up the mocked modules.
const { runSupervisorTick } = await import("../supervisor.js");

function reset(): void {
  h.sessions = [];
  h.activity = new Map();
  h.filesBySession = new Map();
  h.repoRootByDir = new Map();
  h.contendedByRoot = new Map();
  h.toolCallsBySession = new Map();
}

function repeatedFailingCall(times: number): Array<{ name: string; input: unknown; result: unknown; createdAt: string }> {
  return Array.from({ length: times }, () => ({
    name: "Bash",
    input: { command: "pytest" },
    result: { exitCode: 1, output: "FAIL" },
    createdAt: new Date().toISOString(),
  }));
}

beforeEach(() => {
  tempStoreEnv();
  reset();
});

describe("runSupervisorTick", () => {
  it("writes an 'ok' book row for a session with no contention", async () => {
    h.sessions = [{ id: "s1", metadata: { working_directory: "/repo/wt-a", git_branch: "main" } }];
    h.repoRootByDir.set("/repo/wt-a", "/repo/.git");
    h.activity.set("s1", { hasMessages: true, lastMessageAt: "2026-09-15T00:00:00.000Z" });

    const store = new PointGuardStore();
    const result = await runSupervisorTick(store);

    expect(result).toEqual({ observed: 1, conflicted: 0, stuck: 0, pruned: 0, debriefGenerated: true });
    const rows = store.bookRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "s1",
      repo: "/repo/.git",
      branch: "main",
      worktree: "/repo/wt-a",
      status: "ok",
      flaggedReason: null,
    });
    expect(rows[0].lastActivityAt).toBe(Date.parse("2026-09-15T00:00:00.000Z"));
  });

  it("flags both the holder and a waiter as conflicted on a contended path", async () => {
    h.sessions = [
      { id: "holder-session", metadata: { working_directory: "/repo/wt-a" } },
      { id: "waiter-session", metadata: { working_directory: "/repo/wt-b" } },
    ];
    h.repoRootByDir.set("/repo/wt-a", "/repo/.git");
    h.repoRootByDir.set("/repo/wt-b", "/repo/.git");
    h.contendedByRoot.set("/repo/.git", [
      {
        repoRoot: "/repo/.git",
        relPath: "src/index.ts",
        holder: { session_id: "holder-session" },
        waiters: [{ session_id: "waiter-session" }],
      },
    ]);

    const store = new PointGuardStore();
    const result = await runSupervisorTick(store);

    expect(result.conflicted).toBe(2);
    const rows = new Map(store.bookRows().map((r) => [r.sessionId, r]));
    expect(rows.get("holder-session")).toMatchObject({ status: "conflicted", flaggedReason: "contended: src/index.ts" });
    expect(rows.get("waiter-session")).toMatchObject({ status: "conflicted", flaggedReason: "contended: src/index.ts" });
  });

  it("does not flag a session whose repo has no contention, even if other repos do", async () => {
    h.sessions = [
      { id: "quiet-session", metadata: { working_directory: "/other-repo/wt" } },
      { id: "busy-session", metadata: { working_directory: "/repo/wt-a" } },
    ];
    h.repoRootByDir.set("/other-repo/wt", "/other-repo/.git");
    h.repoRootByDir.set("/repo/wt-a", "/repo/.git");
    h.contendedByRoot.set("/repo/.git", [
      { repoRoot: "/repo/.git", relPath: "a.ts", holder: { session_id: "busy-session" }, waiters: [{ session_id: "ghost-session" }] },
    ]);

    const store = new PointGuardStore();
    await runSupervisorTick(store);

    const rows = new Map(store.bookRows().map((r) => [r.sessionId, r]));
    expect(rows.get("quiet-session")?.status).toBe("ok");
    expect(rows.get("busy-session")?.status).toBe("conflicted");
  });

  it("ignores a contention party that is not one of this tick's active sessions", async () => {
    // A waiter/holder id from a session that already ended must not force a
    // book row into existence for a session runSupervisorTick never observed.
    h.sessions = [{ id: "busy-session", metadata: { working_directory: "/repo/wt-a" } }];
    h.repoRootByDir.set("/repo/wt-a", "/repo/.git");
    h.contendedByRoot.set("/repo/.git", [
      { repoRoot: "/repo/.git", relPath: "a.ts", holder: { session_id: "busy-session" }, waiters: [{ session_id: "long-gone" }] },
    ]);

    const store = new PointGuardStore();
    await runSupervisorTick(store);

    const rows = store.bookRows();
    expect(rows.map((r) => r.sessionId)).toEqual(["busy-session"]);
  });

  it("resolves repo/branch to null for a session with no working directory, without crashing", async () => {
    h.sessions = [{ id: "no-cwd-session", metadata: {} }];

    const store = new PointGuardStore();
    const result = await runSupervisorTick(store);

    expect(result.observed).toBe(1);
    const rows = store.bookRows();
    expect(rows[0]).toMatchObject({ repo: null, branch: null, worktree: null, status: "ok" });
  });

  it("degrades a non-git working directory to repo: null rather than failing the tick", async () => {
    h.sessions = [{ id: "scratch-session", metadata: { working_directory: "/tmp/not-a-repo" } }];
    // Deliberately absent from repoRootByDir -- commonDir() mock throws.

    const store = new PointGuardStore();
    const result = await runSupervisorTick(store);

    expect(result.observed).toBe(1);
    expect(store.bookRows()[0]).toMatchObject({ repo: null, status: "ok" });
  });

  it("prunes a book row for a session no longer in the active set", async () => {
    const store = new PointGuardStore();
    store.upsertBookRow({
      sessionId: "long-ended",
      repo: null,
      branch: null,
      worktree: null,
      lastActivityAt: null,
      status: "ok",
      flaggedReason: null,
    });

    h.sessions = [{ id: "still-active", metadata: {} }];
    const result = await runSupervisorTick(store);

    expect(result.pruned).toBe(1);
    expect(store.bookRows().map((r) => r.sessionId)).toEqual(["still-active"]);
  });

  it("continues the tick (no conflicts flagged) when the lock-db read itself fails", async () => {
    h.sessions = [{ id: "s1", metadata: { working_directory: "/repo/wt-a" } }];
    h.repoRootByDir.set("/repo/wt-a", "/repo/.git");
    const { contendedPaths } = await import("@barry-rocks/locks-bag/db");
    vi.mocked(contendedPaths).mockImplementationOnce(() => {
      throw new Error("locks.db unreachable");
    });

    const store = new PointGuardStore();
    const result = await runSupervisorTick(store);

    expect(result.conflicted).toBe(0);
    expect(store.bookRows()[0].status).toBe("ok");
  });

  it("flags a session stuck in a repeated-failure loop", async () => {
    h.sessions = [{ id: "stuck-session", metadata: {} }];
    h.toolCallsBySession.set("stuck-session", repeatedFailingCall(3));

    const store = new PointGuardStore();
    const result = await runSupervisorTick(store);

    expect(result.stuck).toBe(1);
    expect(store.bookRows()[0]).toMatchObject({ status: "stuck" });
    expect(store.bookRows()[0].flaggedReason).toContain("Bash");
  });

  it("does not flag a session merely idle with no tool calls at all as stuck", async () => {
    // Idle-with-no-activity is a DIFFERENT failure shape (last_activity_at's
    // job), not this detector's -- an empty tool-call window must read ok.
    h.sessions = [{ id: "idle-session", metadata: {} }];

    const store = new PointGuardStore();
    const result = await runSupervisorTick(store);

    expect(result.stuck).toBe(0);
    expect(store.bookRows()[0].status).toBe("ok");
  });

  it("prioritizes conflicted over stuck when a session is both", async () => {
    h.sessions = [{ id: "s1", metadata: { working_directory: "/repo/wt-a" } }];
    h.repoRootByDir.set("/repo/wt-a", "/repo/.git");
    h.contendedByRoot.set("/repo/.git", [
      { repoRoot: "/repo/.git", relPath: "a.ts", holder: { session_id: "s1" }, waiters: [{ session_id: "s2" }] },
    ]);
    h.toolCallsBySession.set("s1", repeatedFailingCall(5));

    const store = new PointGuardStore();
    const result = await runSupervisorTick(store);

    expect(result.conflicted).toBe(1);
    expect(result.stuck).toBe(0); // not double-counted under the winning status
    expect(store.bookRows()[0].status).toBe("conflicted");
  });
});
