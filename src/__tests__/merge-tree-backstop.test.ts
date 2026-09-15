/**
 * git merge-tree pairwise simulation -- the conflict-detection backstop
 * for edits that never went through the lock system. Uses REAL git repos
 * (via the same gitf/makeFixtureRepo fixtures the scheduler/verifier tests
 * use), because the exit-code semantics this module depends on
 * (0 = clean, 1 = conflict -- the OPPOSITE of the integer merge-tree
 * embeds in its own stdout) are exactly the kind of detail worth proving
 * against real git rather than trusting from memory.
 */
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitf, makeFixtureRepo } from "./fixture.js";
import { checkMergeTree, pairsToCheck, checkRepoGroup, groupSessionsByRepoRoot, runMergeTreeBackstop, type RepoGroup } from "../merge-tree-backstop.js";

function commitChange(repo: string, file: string, content: string, message: string): string {
  writeFileSync(join(repo, file), content);
  gitf(repo, ["add", "-A"]);
  gitf(repo, ["commit", "-m", message]);
  return gitf(repo, ["rev-parse", "HEAD"]).trim();
}

function branchFrom(repo: string, baseSha: string, branchName: string): void {
  gitf(repo, ["checkout", "-q", "-b", branchName, baseSha]);
}

describe("checkMergeTree", () => {
  it("reports no textual conflict for disjoint-file changes", () => {
    const repo = makeFixtureRepo();
    const baseSha = gitf(repo, ["rev-parse", "HEAD"]).trim();

    branchFrom(repo, baseSha, "session-a");
    const shaA = commitChange(repo, "a.txt", "a content", "session a adds a.txt");

    gitf(repo, ["checkout", "-q", baseSha]);
    branchFrom(repo, baseSha, "session-b");
    const shaB = commitChange(repo, "b.txt", "b content", "session b adds b.txt (disjoint)");

    return checkMergeTree(repo, shaA, shaB).then((verdict) => {
      expect(verdict.textualConflict).toBe(false);
      expect(verdict.error).toBeUndefined();
    });
  });

  it("reports a textual conflict for overlapping edits to the same lines", async () => {
    const repo = makeFixtureRepo();
    const baseSha = gitf(repo, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "shared.txt"), "original\n");
    gitf(repo, ["add", "-A"]);
    gitf(repo, ["commit", "-m", "add shared.txt"]);
    const sharedBase = gitf(repo, ["rev-parse", "HEAD"]).trim();

    branchFrom(repo, sharedBase, "session-a");
    const shaA = commitChange(repo, "shared.txt", "changed-by-a\n", "a edits shared.txt");

    gitf(repo, ["checkout", "-q", sharedBase]);
    branchFrom(repo, sharedBase, "session-b");
    const shaB = commitChange(repo, "shared.txt", "changed-by-b\n", "b edits shared.txt (same line)");

    const verdict = await checkMergeTree(repo, shaA, shaB);
    expect(verdict.textualConflict).toBe(true);
    expect(verdict.error).toBeUndefined();
  });

  it("is symmetric -- order of refs does not change the verdict", async () => {
    const repo = makeFixtureRepo();
    const baseSha = gitf(repo, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "shared.txt"), "original\n");
    gitf(repo, ["add", "-A"]);
    gitf(repo, ["commit", "-m", "add shared.txt"]);
    const sharedBase = gitf(repo, ["rev-parse", "HEAD"]).trim();

    branchFrom(repo, sharedBase, "session-a");
    const shaA = commitChange(repo, "shared.txt", "changed-by-a\n", "a edits");
    gitf(repo, ["checkout", "-q", sharedBase]);
    branchFrom(repo, sharedBase, "session-b");
    const shaB = commitChange(repo, "shared.txt", "changed-by-b\n", "b edits");

    const forward = await checkMergeTree(repo, shaA, shaB);
    const backward = await checkMergeTree(repo, shaB, shaA);
    expect(forward.textualConflict).toBe(backward.textualConflict);
    expect(forward.textualConflict).toBe(true);
  });

  it("reports no conflict, trivially, when both refs are identical", async () => {
    const repo = makeFixtureRepo();
    const sha = gitf(repo, ["rev-parse", "HEAD"]).trim();
    const verdict = await checkMergeTree(repo, sha, sha);
    expect(verdict.textualConflict).toBe(false);
  });

  it("surfaces an error, distinct from a clean verdict, for an unknown ref", async () => {
    const repo = makeFixtureRepo();
    const sha = gitf(repo, ["rev-parse", "HEAD"]).trim();
    const verdict = await checkMergeTree(repo, sha, "not-a-real-ref-xyz");
    expect(verdict.error).toBeTruthy();
    // An indeterminate check must not be reported the same as a real
    // clean answer -- the two are different states for a caller.
  });
});

describe("pairsToCheck", () => {
  it("produces N*(N-1)/2 pairs for N sessions in a group", () => {
    const group: RepoGroup = {
      repoRoot: "/repo",
      refsBySession: new Map([
        ["s1", "ref1"],
        ["s2", "ref2"],
        ["s3", "ref3"],
        ["s4", "ref4"],
      ]),
    };
    expect(pairsToCheck(group)).toHaveLength(6); // 4*3/2
  });

  it("produces no pairs for a single-session group (nothing to compare)", () => {
    const group: RepoGroup = { repoRoot: "/repo", refsBySession: new Map([["s1", "ref1"]]) };
    expect(pairsToCheck(group)).toHaveLength(0);
  });

  it("never pairs a session with itself", () => {
    const group: RepoGroup = {
      repoRoot: "/repo",
      refsBySession: new Map([
        ["s1", "ref1"],
        ["s2", "ref2"],
      ]),
    };
    const pairs = pairsToCheck(group);
    expect(pairs.every((p) => p.sessionA !== p.sessionB)).toBe(true);
  });
});

describe("checkRepoGroup", () => {
  it("finds the conflicting pair among a group of three sessions", async () => {
    const repo = makeFixtureRepo();
    const baseSha = gitf(repo, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "shared.txt"), "original\n");
    gitf(repo, ["add", "-A"]);
    gitf(repo, ["commit", "-m", "add shared.txt"]);
    const sharedBase = gitf(repo, ["rev-parse", "HEAD"]).trim();

    branchFrom(repo, sharedBase, "session-a");
    const shaA = commitChange(repo, "shared.txt", "changed-by-a\n", "a edits shared");

    gitf(repo, ["checkout", "-q", sharedBase]);
    branchFrom(repo, sharedBase, "session-b");
    const shaB = commitChange(repo, "shared.txt", "changed-by-b\n", "b edits shared (conflicts with a)");

    gitf(repo, ["checkout", "-q", sharedBase]);
    branchFrom(repo, sharedBase, "session-c");
    const shaC = commitChange(repo, "unrelated.txt", "c content\n", "c adds unrelated file");

    const findings = await checkRepoGroup({
      repoRoot: repo,
      refsBySession: new Map([
        ["session-a", shaA],
        ["session-b", shaB],
        ["session-c", shaC],
      ]),
    });

    expect(findings).toHaveLength(3);
    const conflicted = findings.filter((f) => f.verdict.textualConflict);
    expect(conflicted).toHaveLength(1);
    expect([conflicted[0].sessionA, conflicted[0].sessionB].sort()).toEqual(["session-a", "session-b"]);
  });
});

describe("groupSessionsByRepoRoot", () => {
  it("groups sessions sharing a repo root and resolves each one's HEAD", async () => {
    const rows = [
      { sessionId: "s1", repo: "/repo/.git", worktree: "/wt-a" },
      { sessionId: "s2", repo: "/repo/.git", worktree: "/wt-b" },
    ];
    const resolveHead = async (wt: string) => (wt === "/wt-a" ? "sha-a" : "sha-b");

    const groups = await groupSessionsByRepoRoot(rows, resolveHead);
    expect(groups).toHaveLength(1);
    expect(groups[0].repoRoot).toBe("/repo/.git");
    expect(Object.fromEntries(groups[0].refsBySession)).toEqual({ s1: "sha-a", s2: "sha-b" });
  });

  it("excludes a repo group with fewer than 2 sessions -- nothing to compare", async () => {
    const rows = [{ sessionId: "s1", repo: "/repo/.git", worktree: "/wt-a" }];
    const groups = await groupSessionsByRepoRoot(rows, async () => "sha-a");
    expect(groups).toHaveLength(0);
  });

  it("excludes sessions with no repo or no worktree", async () => {
    const rows = [
      { sessionId: "s1", repo: null, worktree: "/wt-a" },
      { sessionId: "s2", repo: "/repo/.git", worktree: null },
      { sessionId: "s3", repo: "/repo/.git", worktree: "/wt-c" },
    ];
    const groups = await groupSessionsByRepoRoot(rows, async () => "sha");
    expect(groups).toHaveLength(0); // only s3 has both -- alone in its group
  });

  it("skips one session whose HEAD cannot be resolved, without failing the whole group", async () => {
    const rows = [
      { sessionId: "s1", repo: "/repo/.git", worktree: "/wt-a" },
      { sessionId: "s2", repo: "/repo/.git", worktree: "/wt-broken" },
      { sessionId: "s3", repo: "/repo/.git", worktree: "/wt-c" },
    ];
    const resolveHead = async (wt: string) => {
      if (wt === "/wt-broken") throw new Error("mid-rebase, no resolvable HEAD");
      return `sha-for-${wt}`;
    };

    const groups = await groupSessionsByRepoRoot(rows, resolveHead);
    expect(groups).toHaveLength(1);
    expect([...groups[0].refsBySession.keys()].sort()).toEqual(["s1", "s3"]);
  });

  it("separates sessions into different groups by distinct repo root", async () => {
    const rows = [
      { sessionId: "s1", repo: "/repo-a/.git", worktree: "/wt-1" },
      { sessionId: "s2", repo: "/repo-a/.git", worktree: "/wt-2" },
      { sessionId: "s3", repo: "/repo-b/.git", worktree: "/wt-3" },
      { sessionId: "s4", repo: "/repo-b/.git", worktree: "/wt-4" },
    ];
    const groups = await groupSessionsByRepoRoot(rows, async (wt) => `sha-${wt}`);
    expect(groups.map((g) => g.repoRoot).sort()).toEqual(["/repo-a/.git", "/repo-b/.git"]);
  });
});

describe("runMergeTreeBackstop", () => {
  function fakeStore() {
    const rows = new Map<string, { sessionId: string; repo: string | null; worktree: string | null; status: string; flaggedReason: string | null; mergeTreeCheckedAt: number | null }>();
    return {
      seed(sessionId: string, repo: string, worktree: string) {
        rows.set(sessionId, { sessionId, repo, worktree, status: "ok", flaggedReason: null, mergeTreeCheckedAt: null });
      },
      bookRows: () => [...rows.values()],
      recordMergeTreeCheck(sessionId: string, options?: { escalateStatus?: "conflicted"; flaggedReason?: string }) {
        const row = rows.get(sessionId);
        if (!row) return;
        row.mergeTreeCheckedAt = Date.now();
        if (options?.escalateStatus) {
          row.status = options.escalateStatus;
          row.flaggedReason = options.flaggedReason ?? null;
        }
      },
      snapshot: () => [...rows.values()],
    };
  }

  it("marks a clean-merging pair's sessions as checked, without escalating status", async () => {
    const repo = makeFixtureRepo();
    const baseSha = gitf(repo, ["rev-parse", "HEAD"]).trim();
    branchFrom(repo, baseSha, "session-a");
    commitChange(repo, "a.txt", "a content", "a adds a.txt");
    gitf(repo, ["checkout", "-q", baseSha]);
    branchFrom(repo, baseSha, "session-b");
    commitChange(repo, "b.txt", "b content", "b adds b.txt");

    const store = fakeStore();
    store.seed("session-a", repo, "/wt-a");
    store.seed("session-b", repo, "/wt-b");

    const resolveHead = async (wt: string) => gitf(repo, ["rev-parse", wt === "/wt-a" ? "session-a" : "session-b"]).trim();

    const result = await runMergeTreeBackstop(store, resolveHead);

    expect(result).toEqual({ groupsChecked: 1, pairsChecked: 1, conflictsFound: 0 });
    for (const row of store.snapshot()) {
      expect(row.status).toBe("ok");
      expect(row.mergeTreeCheckedAt).not.toBeNull();
    }
  });

  it("escalates both sessions in a conflicting pair to conflicted, with the honest 'no textual merge' wording", async () => {
    const repo = makeFixtureRepo();
    const baseSha = gitf(repo, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "shared.txt"), "original\n");
    gitf(repo, ["add", "-A"]);
    gitf(repo, ["commit", "-m", "add shared.txt"]);
    const sharedBase = gitf(repo, ["rev-parse", "HEAD"]).trim();

    branchFrom(repo, sharedBase, "session-a");
    commitChange(repo, "shared.txt", "by-a\n", "a edits shared");
    gitf(repo, ["checkout", "-q", sharedBase]);
    branchFrom(repo, sharedBase, "session-b");
    commitChange(repo, "shared.txt", "by-b\n", "b edits shared (conflicts)");

    const store = fakeStore();
    store.seed("session-a", repo, "/wt-a");
    store.seed("session-b", repo, "/wt-b");
    const resolveHead = async (wt: string) => gitf(repo, ["rev-parse", wt === "/wt-a" ? "session-a" : "session-b"]).trim();

    const result = await runMergeTreeBackstop(store, resolveHead);

    expect(result.conflictsFound).toBe(1);
    for (const row of store.snapshot()) {
      expect(row.status).toBe("conflicted");
      expect(row.flaggedReason).toContain("no textual merge");
      // Must never overclaim "safe" -- only ever the honest, narrower claim.
      expect(row.flaggedReason).not.toMatch(/safe|clean|compatible/i);
    }
  });

  it("records the explicit zero: a session in a checked group with no conflict is marked checked, not silently untouched", async () => {
    const repo = makeFixtureRepo();
    const baseSha = gitf(repo, ["rev-parse", "HEAD"]).trim();
    branchFrom(repo, baseSha, "session-a");
    commitChange(repo, "a.txt", "content", "a adds a.txt");
    gitf(repo, ["checkout", "-q", baseSha]);
    branchFrom(repo, baseSha, "session-b");
    commitChange(repo, "b.txt", "content", "b adds b.txt");

    const store = fakeStore();
    store.seed("session-a", repo, "/wt-a");
    store.seed("session-b", repo, "/wt-b");
    const resolveHead = async (wt: string) => gitf(repo, ["rev-parse", wt === "/wt-a" ? "session-a" : "session-b"]).trim();

    const before = store.snapshot().map((r) => r.mergeTreeCheckedAt);
    expect(before.every((t) => t === null)).toBe(true); // never checked yet

    await runMergeTreeBackstop(store, resolveHead);

    const after = store.snapshot().map((r) => r.mergeTreeCheckedAt);
    expect(after.every((t) => t !== null)).toBe(true); // now provably checked
  });

  it("does nothing when no repo group has 2+ sessions", async () => {
    const store = fakeStore();
    store.seed("lonely-session", "/some/repo", "/wt-only");
    const result = await runMergeTreeBackstop(store, async () => "sha");
    expect(result).toEqual({ groupsChecked: 0, pairsChecked: 0, conflictsFound: 0 });
  });
});
