/**
 * The debrief: one structured snapshot of what the whole team of sessions is
 * doing right now, for the clients to render.
 *
 * The book answers "what is each session's status". The debrief answers "what
 * is the team doing" -- the book plus the identity, duration, plan and
 * trouble context the book deliberately does not carry.
 *
 * It is a SECOND read-model over the same tick, never a competing
 * computation: status comes from the book verbatim. If the two ever disagree
 * about a session, the book is right and this file is the bug.
 *
 * Cached and served from SQLite, never computed on the request path, for the
 * same reason GET /book reads its cache: clients poll on timers, and a
 * per-request recompute would multiply every poll into Postgres reads, git
 * calls and (worse) model calls.
 */
import { createHash } from "node:crypto";
import { getName, type SessionRecord } from "@barry-rocks/db";
import { createLogger } from "@barry-rocks/logger";
import type { PointGuardStore } from "./store.js";

const log = createLogger("point-guard:debrief");

/**
 * A session whose last message is newer than this counts as "working".
 * 10 minutes is long enough to span one slow tool call or a model round-trip
 * on a big context, short enough that a session someone walked away from
 * stops claiming to be busy.
 */
export const WORKING_WINDOW_MS = 10 * 60 * 1000;

/** The bookkeeping summary is an append-only log; only its newest entry
 *  describes the present, and a multi-day log would dominate the payload. */
export const SUMMARY_EXCERPT_CHARS = 400;

/** A plan untouched for this long is not what this team is doing now. */
export const PLAN_STALENESS_MS = 14 * 24 * 60 * 60 * 1000;

/** Trouble entries returned at most. The counts carry the true scale, so a
 *  cap here loses nothing that matters and keeps one bad day from producing
 *  a payload nobody can read. */
export const TROUBLE_CAP = 50;

export type DebriefSourceName = "sessions" | "plans";

export interface DebriefSourceStatus {
  /** Last SUCCESSFUL read. null = never read successfully since boot.
   *  Never means "the read returned nothing" -- that is a timestamp. */
  lastSucceededAt: number | null;
  /** Error from the most recent attempt, or null when it SUCCEEDED. Non-null
   *  here alongside a non-null lastSucceededAt means "stale, shown anyway". */
  lastError: string | null;
}

export interface DebriefCounts {
  total: number;
  /** status ok AND active within WORKING_WINDOW_MS. */
  working: number;
  /** status ok AND quiet (or never active). */
  idle: number;
  stuck: number;
  conflicted: number;
}

export interface DebriefPlanLink {
  id: string;
  title: string;
  status: string;
  progress: { done: number; total: number; of: string };
  url: string;
  /**
   * HOW this plan reached this session. Only "repo" is possible today, and
   * it means "this plan names the repo this session is in" -- NOT "this
   * session is working on it". Sixteen sessions share one repo here, so a
   * repo-scoped plan attaches to all sixteen. Clients must render the
   * qualifier. "session" is reserved for a real link if one is ever built.
   */
  match: "repo" | "session";
}

export interface DebriefSession {
  sessionId: string;
  /** getName(): metadata.name, else system_prompt[0:50], else id[0:8].
   *  Never null. nameSource says which fallback produced it, so a client can
   *  style a real name differently from an id stub. */
  name: string;
  nameSource: "metadata" | "systemPrompt" | "idStub";
  repo: string | null;
  /** Short display form of repo ("barry"), null when repo is null. */
  repoName: string | null;
  branch: string | null;
  worktree: string | null;
  /** The session row's own lifecycle status. A session can be active AND
   *  "completed"; the debrief shows both rather than picking one. */
  lifecycleStatus: string;
  /** The book's verdict, read verbatim. Never re-derived here. */
  status: "ok" | "stuck" | "conflicted";
  /** Non-null ONLY when status !== "ok". */
  flaggedReason: string | null;
  createdAt: number;
  /** null = this session has produced NO messages at all. Distinct from
   *  "old activity", which is a real number. */
  lastActivityAt: number | null;
  /** How long the session has EXISTED -- not working time. A session created
   *  four days ago and active this minute reports four days. Clients must
   *  label it "alive", never "working". */
  aliveMs: number;
  /** null when lastActivityAt is null. */
  idleMs: number | null;
  /** Newest entry of the bookkeeping job's append-only summary, trimmed.
   *  null = that job has never summarized this session. MODEL-WRITTEN text
   *  from another job, not a measurement -- render as description, not
   *  status. */
  latestSummary: string | null;
  /** Distinct files touched per file-tracker. 0 is a measured zero (a
   *  read-only session genuinely touched none), never "unknown". */
  filesTouched: number;
  /** null = THE SLOW MERGE-TREE CHECK HAS NEVER RUN for this session.
   *  A timestamp = it ran and found no textual conflict. Passed through from
   *  the book verbatim; these semantics are already right and must not be
   *  re-derived or collapsed. */
  mergeTreeCheckedAt: number | null;
  plans: DebriefPlanLink[];
}

export interface DebriefTrouble {
  /** Stable, so a client can diff two debriefs without re-rendering. */
  id: string;
  kind: "session_stuck" | "conflict_detected" | "delegation_blocked" | "delegation_failed" | "outbox_undelivered";
  /** null for troubles belonging to no single session (outbox). */
  sessionId: string | null;
  /** Taken from the underlying row, never synthesized. */
  detail: string;
  at: number;
}

export interface DebriefNarrative {
  text: string;
  model: string;
  generatedAt: number;
  /** Hash of the structured inputs this text was written FROM. When it
   *  differs from the debrief's own inputsHash, the prose describes an older
   *  state -- clients mark it stale rather than hiding it. */
  inputsHash: string;
}

export interface Debrief {
  generatedAt: number;
  counts: DebriefCounts;
  sessions: DebriefSession[];
  /** Open plans across all sessions, deduped -- a repo-level view for a
   *  client that wants one list rather than per-session chips. Empty = the
   *  plans service answered and had none; check sources.plans to tell that
   *  from "could not ask". */
  plans: DebriefPlanLink[];
  trouble: DebriefTrouble[];
  /** null = NO NARRATIVE HAS BEEN GENERATED YET (first boot, or every
   *  attempt failed). Never a placeholder string: a client must be able to
   *  tell "not generated" from "generated, and it says little". */
  narrative: DebriefNarrative | null;
  inputsHash: string;
  sources: Record<DebriefSourceName, DebriefSourceStatus>;
}

/** Which fallback getName() landed on. Mirrors its precedence exactly; if
 *  that function changes, this must change with it. */
function nameSourceOf(session: SessionRecord): DebriefSession["nameSource"] {
  if (session.metadata.name) return "metadata";
  if (session.system_prompt) return "systemPrompt";
  return "idStub";
}

/**
 * "barry" from "/Users/tyler/repos/barry/.git". The book stores a git
 * common-dir, which ends in /.git for a normal clone -- the readable name is
 * its parent's basename.
 */
export function repoDisplayName(repo: string | null): string | null {
  if (!repo) return null;
  const withoutGit = repo.endsWith("/.git") ? repo.slice(0, -"/.git".length) : repo;
  const base = withoutGit.split("/").filter(Boolean).pop();
  return base ?? null;
}

/**
 * The newest entry of the bookkeeping job's summary log.
 *
 * That job appends `### <date>` sections, newest last, so the present is the
 * tail rather than the head -- taking the first would describe whatever the
 * session was doing when it started, which for a four-day-old session is
 * actively misleading.
 */
export function latestSummaryEntry(summary: string | null | undefined): string | null {
  if (!summary) return null;
  const trimmed = summary.trim();
  if (!trimmed) return null;

  // Split on DATE-headed entries only. The job writes `### 2026-08-26 05:04`
  // per entry, but each entry also contains `### Done` / `### Learnings`
  // subsections at the same heading level -- splitting on every `###` would
  // cut one entry into pieces and return just its last subsection.
  const entryHeader = /^###\s+(\d{4}-\d{2}-\d{2}[^\n]*)$/gm;
  const starts: number[] = [];
  for (const m of trimmed.matchAll(entryHeader)) {
    if (m.index !== undefined) starts.push(m.index);
  }

  const newest = starts.length > 0 ? trimmed.slice(starts[starts.length - 1]) : trimmed;
  // Drop the date header itself: a client is showing "what is this session
  // doing", and a bare timestamp as the first line is noise.
  const body = newest.replace(entryHeader, "").trim();
  const text = body || newest.trim();
  return text.length > SUMMARY_EXCERPT_CHARS ? `${text.slice(0, SUMMARY_EXCERPT_CHARS)}…` : text;
}

/** Counts from the per-session rows, so they can never disagree with the
 *  table a client renders beside them. */
export function countSessions(sessions: DebriefSession[], now: number): DebriefCounts {
  let working = 0;
  let idle = 0;
  let stuck = 0;
  let conflicted = 0;
  for (const s of sessions) {
    if (s.status === "stuck") stuck += 1;
    else if (s.status === "conflicted") conflicted += 1;
    else if (s.lastActivityAt !== null && now - s.lastActivityAt <= WORKING_WINDOW_MS) working += 1;
    else idle += 1;
  }
  return { total: sessions.length, working, idle, stuck, conflicted };
}

/**
 * Hash of the structured content only.
 *
 * generatedAt and narrative are excluded deliberately: including either would
 * change the hash every single tick, so the narrative would regenerate every
 * five minutes forever and the stale-marker would never mean anything.
 */
export function hashDebriefInputs(input: {
  counts: DebriefCounts;
  sessions: DebriefSession[];
  plans: DebriefPlanLink[];
  trouble: DebriefTrouble[];
}): string {
  const stable = {
    counts: input.counts,
    sessions: input.sessions.map((s) => ({
      id: s.sessionId,
      status: s.status,
      reason: s.flaggedReason,
      name: s.name,
      summary: s.latestSummary,
      plans: s.plans.map((p) => p.id).sort(),
    })),
    plans: input.plans.map((p) => `${p.id}:${p.status}`).sort(),
    trouble: input.trouble.map((t) => t.id).sort(),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
}
