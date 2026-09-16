/**
 * The book: a periodic sweep that recomputes point-guard's view of every
 * active Barry session -- both interactive claude/codex/etc sessions AND
 * point-guard's own delegation workers, since a worker run IS a session row
 * (worker.ts registers it as one for exactly this reason).
 *
 * This is a CQRS read-model, not a log: every tick reads the real
 * source-of-truth tables fresh and overwrites the book's cached view of what
 * it found. Nothing here is the source of truth for anything -- delete the
 * book table and the next tick rebuilds it byte-for-byte from `sessions`,
 * `messages`, `locks.db`, and `file-tracker.db`.
 *
 * Hard rule (a live incident, not a guess): this module NEVER opens
 * `~/.barry/locks.db` or `~/.barry/file-tracker.db` with its own SQLite
 * handle. Both already expose query functions through their owning
 * packages -- go through those, never read a file out from under the
 * process that holds its write lock.
 */
import { getActiveSessions, getLatestActivityBySessions, getRecentToolCallsBySessions, type SessionRecord } from "@barry-rocks/db";
import { getDb as getLocksDb, contendedPaths } from "@barry-rocks/locks-bag/db";
import { getDistinctFilesForSessions } from "@barry-rocks/file-tracker";
import { createLogger } from "@barry-rocks/logger";
import { commonDir } from "./gitwt.js";
import { evaluateStuck } from "./stuck-detection.js";
import { assembleTrouble, buildDebrief } from "./debrief.js";
import { fetchOpenPlans, remoteSlugFor } from "./debrief-plans.js";
import type { PointGuardStore } from "./store.js";

const log = createLogger("point-guard:supervisor");

export type BookStatus = "ok" | "stuck" | "conflicted";

export interface BookVerdict {
  sessionId: string;
  repo: string | null;
  branch: string | null;
  worktree: string | null;
  lastActivityAt: number | null;
  status: BookStatus;
  flaggedReason: string | null;
}

/**
 * Resolve a session's working directory to its git common-dir (the identity
 * shared across a repo and all its linked worktrees -- the same one
 * locks.db's intents key on). Best-effort: a session's cwd may not be a git
 * repo at all (a scratch dir, a non-code task), which is not an error, just
 * a session the conflict layer has nothing to cross-reference.
 */
async function resolveRepoRoot(workingDirectory: string | null | undefined): Promise<string | null> {
  if (!workingDirectory) return null;
  try {
    return await commonDir(workingDirectory);
  } catch {
    return null;
  }
}

/**
 * One supervisor tick: read the real sources, compute a verdict per active
 * session, write it to the book, then drop any book row for a session this
 * tick did not see at all (it ended, or was archived).
 *
 * Conflict detection here is the REAL-TIME tier (read locks.db's already-
 * computed intents/holders); the git-merge-tree backstop for edits that
 * never went through the lock system runs separately, on its own slower
 * interval (Phase C, see merge-tree-backstop.ts and
 * server/src/index.ts's own scheduling of it) -- this function does not
 * run it inline. When a session is both stuck AND conflicted, conflicted
 * wins: it can block OTHER sessions, so it's the more urgent state to
 * surface, even though both are independently true.
 */
export async function runSupervisorTick(store: PointGuardStore): Promise<{ observed: number; conflicted: number; stuck: number; pruned: number; debriefGenerated: boolean }> {
  const sessions = await getActiveSessions();
  const sessionIds = sessions.map((s) => s.id);

  const [activity, filesBySession, recentToolCalls] = await Promise.all([
    getLatestActivityBySessions(sessionIds),
    Promise.resolve(getDistinctFilesForSessions(sessionIds)),
    getRecentToolCallsBySessions(sessionIds),
  ]);

  // One commonDir() resolution per distinct working directory, not per
  // session -- several sessions in the same repo (main checkout + worktrees)
  // would otherwise repeat the same `git rev-parse` call needlessly.
  const uniqueDirs = [...new Set(sessions.map((s) => s.metadata.working_directory).filter((d): d is string => !!d))];
  const repoRootByDir = new Map<string, string | null>();
  await Promise.all(
    uniqueDirs.map(async (dir) => {
      repoRootByDir.set(dir, await resolveRepoRoot(dir));
    }),
  );

  const repoRootBySession = new Map<string, string | null>();
  for (const session of sessions) {
    const dir = session.metadata.working_directory;
    repoRootBySession.set(session.id, dir ? (repoRootByDir.get(dir) ?? null) : null);
  }

  // Real-time conflict tier: for every distinct repo root in play, ask
  // locks.db what's currently contended, then find which of our sessions
  // are a holder or a waiter on one of those paths.
  const conflictedSessions = new Map<string, string>(); // sessionId -> reason
  const distinctRepoRoots = [...new Set([...repoRootBySession.values()].filter((r): r is string => !!r))];
  if (distinctRepoRoots.length > 0) {
    try {
      const locksDb = getLocksDb();
      for (const repoRoot of distinctRepoRoots) {
        for (const entry of contendedPaths(locksDb, repoRoot)) {
          const parties = [entry.holder?.session_id, ...entry.waiters.map((w) => w.session_id)].filter(
            (id): id is string => !!id,
          );
          for (const sessionId of parties) {
            if (!sessionIds.includes(sessionId)) continue; // a party from an unrelated/ended session
            const existing = conflictedSessions.get(sessionId);
            const reason = `contended: ${entry.relPath}`;
            conflictedSessions.set(sessionId, existing ? `${existing}; ${reason}` : reason);
          }
        }
      }
    } catch (error) {
      // Fail open: a lock-db read problem must not make every session read
      // as conflicted. It also must not make every session read as clean --
      // this only decides THIS tick's conflict tier; the book row keeps
      // whatever this tick otherwise found.
      log.warn(`conflict sweep skipped this tick: ${String(error)}`);
    }
  }

  let stuckCount = 0;
  for (const session of sessions) {
    const dir = session.metadata.working_directory ?? null;
    const branch = session.metadata.git_branch ?? null;
    const repoRoot = repoRootBySession.get(session.id) ?? null;
    const sessionActivity = activity.get(session.id);
    const conflictReason = conflictedSessions.get(session.id);

    let status: BookStatus = "ok";
    let flaggedReason: string | null = null;
    if (conflictReason) {
      status = "conflicted";
      flaggedReason = conflictReason;
    } else {
      const stuckVerdict = evaluateStuck(recentToolCalls.get(session.id) ?? []);
      if (stuckVerdict.stuck && stuckVerdict.repeatedCall) {
        status = "stuck";
        flaggedReason = `repeated ${stuckVerdict.repeatedCall.count}x with the same outcome: ${stuckVerdict.repeatedCall.tool}`;
        stuckCount += 1;
      }
    }

    const verdict: BookVerdict = {
      sessionId: session.id,
      repo: repoRoot,
      branch,
      worktree: dir,
      lastActivityAt: sessionActivity?.lastMessageAt ? Date.parse(sessionActivity.lastMessageAt) : null,
      status,
      flaggedReason,
    };

    store.upsertBookRow({
      sessionId: verdict.sessionId,
      repo: verdict.repo,
      branch: verdict.branch,
      worktree: verdict.worktree,
      lastActivityAt: verdict.lastActivityAt,
      status: verdict.status,
      flaggedReason: verdict.flaggedReason,
    });
  }

  const pruned = store.pruneBookRows(new Set(sessionIds));

  // The debrief is a SECOND read-model over this same tick: it reads the
  // book back rather than recomputing status, so the two can never disagree
  // about whether a session is stuck. A failure here must not cost the book,
  // which is already durable by this point.
  let debriefGenerated = false;
  try {
    // One remote lookup per distinct worktree, on the same batching path the
    // commonDir resolution above already uses.
    const slugByDir = new Map<string, string | null>();
    await Promise.all(
      uniqueDirs.map(async (dir) => {
        slugByDir.set(dir, await remoteSlugFor(dir));
      }),
    );
    const slugBySession = new Map<string, string | null>();
    for (const session of sessions) {
      const dir = session.metadata.working_directory;
      slugBySession.set(session.id, dir ? (slugByDir.get(dir) ?? null) : null);
    }

    const plans = await fetchOpenPlans();
    const now = Date.now();
    const cachedNarrative = store.debriefNarrative();

    const debrief = buildDebrief({
      sessions,
      book: store.bookRows(),
      filesBySession,
      slugBySession,
      plans,
      trouble: assembleTrouble({
        book: store.bookRows(),
        events: store.recentEvents(50),
        delegations: [
          ...store.listDelegations({ state: "blocked" }),
          ...store.listDelegations({ state: "failed" }),
        ].map((d) => ({ id: d.id, state: d.state, reason: d.reason, updatedAt: d.updated_at })),
        outbox: store.failingOutbox(),
      }),
      narrative: cachedNarrative
        ? {
            text: cachedNarrative.text,
            model: cachedNarrative.model,
            generatedAt: cachedNarrative.generatedAt,
            inputsHash: cachedNarrative.inputsHash,
          }
        : null,
      now,
    });

    store.putDebriefSnapshot(JSON.stringify(debrief), debrief.inputsHash);
    debriefGenerated = true;
  } catch (error) {
    log.warn(`debrief skipped this tick: ${String(error)}`);
  }

  return { observed: sessions.length, conflicted: conflictedSessions.size, stuck: stuckCount, pruned, debriefGenerated };
}
