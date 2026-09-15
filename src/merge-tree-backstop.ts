/**
 * Conflict detection, backstop tier: `git merge-tree` pairwise simulation
 * across sessions sharing a repo root, for edits that never went through
 * the lock system (e.g. a shell command the write guard did not catch --
 * the exact gap locks_unclaimed already names for a single session; this
 * is the cross-session version of that same blind spot).
 *
 * This is a BACKSTOP, not the primary signal -- the real-time tier
 * (supervisor.ts reading locks.db's already-computed intents) is cheaper
 * and catches everything that went through Barry's own edit tools. This
 * tier exists for what that one cannot see.
 *
 * Honesty note (a real overclaim to avoid): `git merge-tree` reports
 * TEXTUAL conflicts only. Two sessions editing disjoint files, or the
 * same file in non-overlapping regions, merge "cleanly" by this check even
 * when the result is semantically broken (e.g. two independently-valid
 * changes that both pass in isolation but fail combined -- exactly the
 * case verifier.test.ts's "two independently green candidates" test
 * covers for point-guard's OWN merge queue). This module's verdict is
 * "no textual conflict detected", never "safe" or "compatible" -- callers
 * must not upgrade that wording.
 */
import { git } from "./gitwt.js";

export interface MergeTreeVerdict {
  /** Whether git merge-tree found a textual conflict between the two refs.
   * Named `textualConflict`, not `conflict` or `unsafe` -- see the file
   * header on why the stronger word would be a real claim this check
   * cannot back up. */
  textualConflict: boolean;
  /** Present only when the merge-tree invocation itself failed (unknown
   * ref, not a git repo, timeout) -- distinct from a clean or conflicting
   * merge, which are both real answers this function got to. A caller
   * must NOT treat this the same as textualConflict: false; an
   * indeterminate check is not a check that passed. */
  error?: string;
}

/**
 * Simulate a merge between two refs in a repo, without touching the index
 * or working tree (git merge-tree's whole point -- safe to run against a
 * repo other sessions are actively using).
 *
 * `git merge-tree --write-tree`'s PROCESS exit code is 0 for a clean
 * merge, 1 for a conflicted one -- the OPPOSITE of the "Merge status"
 * integer embedded in its own stdout (which is 1 for clean, 0 for
 * conflicts, a genuinely easy detail to get backwards). Verified directly
 * against a real git invocation before relying on it, not from memory of
 * the man page alone.
 */
export async function checkMergeTree(repoRoot: string, refA: string, refB: string): Promise<MergeTreeVerdict> {
  if (refA === refB) return { textualConflict: false }; // trivially the same ref
  try {
    const result = await git(repoRoot, ["merge-tree", "--write-tree", refA, refB], { allowFailure: true });
    if (result.code === 0) return { textualConflict: false };
    if (result.code === 1) {
      // A conflict is a real, meaningful "1" -- but merge-tree also exits
      // 1 on a genuine usage error (unknown ref, unrelated histories). The
      // stdout for a real conflict always contains "CONFLICT"; a usage
      // error's stdout does not. Distinguish rather than assume.
      if (result.stdout.includes("CONFLICT")) {
        return { textualConflict: true };
      }
      return { textualConflict: false, error: `merge-tree exited 1 without a CONFLICT marker (likely a usage error): ${result.stdout.slice(0, 500) || result.stderr.slice(0, 500)}` };
    }
    return { textualConflict: false, error: `merge-tree exited ${result.code}: ${result.stderr.slice(0, 500)}` };
  } catch (error) {
    return { textualConflict: false, error: String(error) };
  }
}

export interface RepoGroup {
  repoRoot: string;
  /** sessionId -> the ref to compare (branch tip, or a commit sha). */
  refsBySession: Map<string, string>;
}

export interface MergeTreeFinding {
  repoRoot: string;
  sessionA: string;
  sessionB: string;
  verdict: MergeTreeVerdict;
}

/**
 * Every pairwise combination within one repo group. A group of N sessions
 * yields N*(N-1)/2 comparisons -- fine at the scale point-guard watches
 * (a handful of concurrent sessions per repo, not hundreds), and each
 * comparison is independent so callers can run them concurrently.
 */
export function pairsToCheck(group: RepoGroup): Array<{ sessionA: string; refA: string; sessionB: string; refB: string }> {
  const entries = [...group.refsBySession.entries()];
  const pairs: Array<{ sessionA: string; refA: string; sessionB: string; refB: string }> = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [sessionA, refA] = entries[i];
      const [sessionB, refB] = entries[j];
      pairs.push({ sessionA, refA, sessionB, refB });
    }
  }
  return pairs;
}

/** Run every pairwise merge-tree check for one repo group, concurrently. */
export async function checkRepoGroup(group: RepoGroup): Promise<MergeTreeFinding[]> {
  const pairs = pairsToCheck(group);
  const results = await Promise.all(
    pairs.map(async (pair) => ({
      repoRoot: group.repoRoot,
      sessionA: pair.sessionA,
      sessionB: pair.sessionB,
      verdict: await checkMergeTree(group.repoRoot, pair.refA, pair.refB),
    })),
  );
  return results;
}

/**
 * Build the repo groups for this backstop pass from the book's current
 * rows -- every session with BOTH a resolved repo root and a worktree
 * path, grouped by that root, with each session's worktree HEAD resolved
 * to a concrete commit (merge-tree needs a ref, not a directory path).
 * Sessions with neither a repo root nor a worktree have nothing for this
 * tier to compare; a worktree whose HEAD cannot be resolved (mid-rebase,
 * deleted, transient git-state) is skipped rather than failing the whole
 * group -- one bad worktree should not blind the check for every other
 * pair in the same repo.
 *
 * Honesty note: this compares committed HEAD only. A session's
 * uncommitted working-tree changes are invisible to git merge-tree by
 * construction -- this backstop cannot see work that hasn't been
 * committed anywhere, which is a real, permanent limitation of comparing
 * refs rather than working trees.
 */
export async function groupSessionsByRepoRoot(
  bookRows: Array<{ sessionId: string; repo: string | null; worktree: string | null }>,
  resolveHead: (worktree: string) => Promise<string>,
): Promise<RepoGroup[]> {
  const byRoot = new Map<string, Array<{ sessionId: string; worktree: string }>>();
  for (const row of bookRows) {
    if (!row.repo || !row.worktree) continue;
    const group = byRoot.get(row.repo) ?? [];
    group.push({ sessionId: row.sessionId, worktree: row.worktree });
    byRoot.set(row.repo, group);
  }

  const groups: RepoGroup[] = [];
  for (const [repoRoot, sessions] of byRoot) {
    if (sessions.length < 2) continue; // nothing to compare with fewer than 2
    const refsBySession = new Map<string, string>();
    await Promise.all(
      sessions.map(async ({ sessionId, worktree }) => {
        try {
          refsBySession.set(sessionId, await resolveHead(worktree));
        } catch {
          // Skip this session for this pass; do not fail the whole group.
        }
      }),
    );
    if (refsBySession.size >= 2) groups.push({ repoRoot, refsBySession });
  }
  return groups;
}

/**
 * The full backstop pass: group the book's current sessions by repo root,
 * run every pairwise merge-tree check, and record the result on each
 * involved session's book row. Callers own the interval this runs on
 * (slower than the main supervisor tick -- see server/src/index.ts) and
 * the choice to log/notify on findings; this function's only job is
 * running the checks and updating the store.
 */
export async function runMergeTreeBackstop(
  store: { bookRows(): Array<{ sessionId: string; repo: string | null; worktree: string | null }>; recordMergeTreeCheck(sessionId: string, options?: { escalateStatus?: "conflicted"; flaggedReason?: string }): void },
  resolveHead: (worktree: string) => Promise<string>,
): Promise<{ groupsChecked: number; pairsChecked: number; conflictsFound: number }> {
  const groups = await groupSessionsByRepoRoot(store.bookRows(), resolveHead);
  let pairsChecked = 0;
  let conflictsFound = 0;

  for (const group of groups) {
    const findings = await checkRepoGroup(group);
    pairsChecked += findings.length;
    const checkedSessions = new Set(group.refsBySession.keys());

    for (const finding of findings) {
      if (finding.verdict.textualConflict) {
        conflictsFound += 1;
        const reason = `merge-tree backstop: no textual merge with ${finding.sessionB}`;
        store.recordMergeTreeCheck(finding.sessionA, { escalateStatus: "conflicted", flaggedReason: reason });
        store.recordMergeTreeCheck(finding.sessionB, {
          escalateStatus: "conflicted",
          flaggedReason: `merge-tree backstop: no textual merge with ${finding.sessionA}`,
        });
        checkedSessions.delete(finding.sessionA);
        checkedSessions.delete(finding.sessionB);
      }
    }

    // Every session in the group that wasn't escalated above still had the
    // check run against it -- record that plainly, per the "explicit zero"
    // rule: a session with no conflict finding this pass is one the check
    // actually looked at, not one it forgot.
    for (const sessionId of checkedSessions) {
      store.recordMergeTreeCheck(sessionId);
    }
  }

  return { groupsChecked: groups.length, pairsChecked, conflictsFound };
}
