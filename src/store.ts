/**
 * Point-guard's durable state. SQLite is the ONLY source of truth; every model
 * context, TUI view, and Barry-session projection is a disposable view over
 * these tables. If this file and the git objects survive a crash, everything
 * else is reconstructible.
 *
 * Schema is inlined (not read from a migrations dir) because import.meta.url
 * does not survive esbuild bundling into the bag cache — the approvals bag
 * documents the same scar.
 *
 * State transitions are guarded inside the UPDATE's WHERE clause so the first
 * writer wins and an illegal transition is a refused write, not a corrupted
 * row. Everything fails toward "not accepted" / "not merged".
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  DELEGATION_TRANSITIONS,
  type DelegationBrief,
  type DelegationState,
  type PlanStep,
  type PlanStepStatus,
} from "./contracts.js";

export function pointGuardDbPath(): string {
  return process.env.BARRY_POINT_GUARD_DB ?? join(homedir(), ".barry", "point-guard.db");
}

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  repo TEXT,
  identity TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','brain','system')),
  content TEXT NOT NULL,
  -- Client-supplied idempotency key. A replayed request is a no-op, not a
  -- duplicate message (plan invariant #7).
  request_id TEXT UNIQUE,
  sequence INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_conv_seq ON chat_messages(conversation_id, sequence);

CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  state TEXT NOT NULL,
  contract_revision INTEGER NOT NULL DEFAULT 1,
  contract_hash TEXT NOT NULL,
  brief_json TEXT NOT NULL,
  repo TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  baseline_sha TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  -- Frozen at dispatch: protected-file hashes and dispatch metadata. Part of
  -- the contract; verification compares against THESE, not a re-read.
  dispatch_json TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delegations_state ON delegations(state, updated_at);

-- Attempt history is separate and append-only; a delegation row never
-- overwrites what attempt N did (plan: do not overwrite attempt history).
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  delegation_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('worker','judge','brain','integration')),
  attempt_number INTEGER,
  provider TEXT NOT NULL,
  model TEXT,
  state TEXT NOT NULL CHECK (state IN ('running','succeeded','failed','timeout','cancelled','unknown')),
  barry_session_id TEXT,
  provider_session_id TEXT,
  pid INTEGER,
  pid_started_at TEXT,
  usage_json TEXT,
  failure_reason TEXT,
  deadline_at INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_delegation ON runs(delegation_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  delegation_id TEXT NOT NULL,
  run_id TEXT,
  candidate_sha TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('report','mechanical','judge','diff','integration-mechanical','integration-judge')),
  payload_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_delegation ON evidence(delegation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_evidence_candidate ON evidence(candidate_sha, kind);

CREATE TABLE IF NOT EXISTS merge_queue (
  id TEXT PRIMARY KEY,
  delegation_id TEXT NOT NULL UNIQUE,
  repo_common_dir TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  accepted_sha TEXT NOT NULL,
  observed_target_sha TEXT,
  integrated_sha TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued','claimed','integrated','publishing','published','failed')),
  reason TEXT,
  -- Written BEFORE update-ref (publication intent), so crash recovery can
  -- tell "published" from "provably did not publish" (plan: intent-before-effect).
  publication_intent_at INTEGER,
  published_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_target ON merge_queue(repo_common_dir, target_ref, state);

CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('core','archive')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  through_sequence INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  text TEXT NOT NULL,
  answer TEXT,
  asked_at INTEGER NOT NULL,
  answered_at INTEGER
);

CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  delegation_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost_usd REAL,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_delegation ON ledger(delegation_id);

-- Transactional outbox toward Barry (session rows, usage, events). A projection
-- outage queues here and stays VISIBLE (undelivered rows), never silently lost
-- and never fabricated as zeros.
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(delivered_at) WHERE delivered_at IS NULL;

-- The service event stream: monotone cursor, replayable, deduped by id.
CREATE TABLE IF NOT EXISTS stream_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Plans are received, never authored: planning happens outside point-guard.
-- steps_json is the FROZEN input as submitted -- point-guard never rewrites
-- step text, only tracks status against it.
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plan_steps (
  plan_id TEXT NOT NULL REFERENCES plans(id),
  step_id TEXT NOT NULL,
  delegation_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','in_progress','done','skipped','failed')),
  -- The worker's own retrospective (summary + limitations from its final
  -- report) for THIS step -- populated once, when the report arrives.
  -- Never authored by point-guard; never a plan/authoring field.
  retrospective_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plan_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_steps_delegation ON plan_steps(delegation_id);

-- The book: one row per Barry session point-guard is currently watching
-- (both interactive claude/codex/etc sessions AND point-guard's own
-- delegation workers, keyed by their session_id from the sessions table --
-- never by name, which is optional/display-only and collision-prone).
-- Recomputed from source-of-truth tables every supervisor tick (a CQRS
-- read-model, not an accumulated log) -- a row here is a cache of what the
-- last tick observed, never itself the source of truth for anything.
CREATE TABLE IF NOT EXISTS book (
  session_id TEXT PRIMARY KEY,
  repo TEXT,
  branch TEXT,
  worktree TEXT,
  last_activity_at INTEGER,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','stuck','conflicted')),
  flagged_reason TEXT,
  -- The merge-tree backstop runs on a LONGER interval than the main tick
  -- (Phase C: expensive, so cheaper than running it every 60s). NULL here
  -- means "this slower check has never run for this session" -- distinct
  -- from "ran and found nothing", which the main tick's own updated_at
  -- already proves for everything else. Without this column, a fresh
  -- session and a genuinely-clean session are indistinguishable.
  merge_tree_checked_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_book_status ON book(status);
CREATE INDEX IF NOT EXISTS idx_book_updated ON book(updated_at);

-- POST /message's "very minimal history" (plan decision 6): a display-only
-- scrollback of (message, reply, timestamp) for the human's own benefit --
-- "what did I ask yesterday" -- NEVER read back into the next call's
-- context. Each message is answered fresh from a book snapshot (the
-- Heartbeat pattern); there is deliberately no conversation_id linking rows
-- together, because there is no conversation to link.
CREATE TABLE IF NOT EXISTS messages_log (
  id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  reply TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_log_created ON messages_log(created_at);

-- The debrief's cached snapshot: one row, rewritten each supervisor tick.
-- Cached for the same reason GET /book reads its cache rather than computing:
-- clients poll on timers, so a per-request recompute would multiply every
-- poll into Postgres reads and git calls.
--
-- Deliberately NOT guarded by a SCHEMA_VERSION bump. Both debrief tables are
-- pure caches -- delete either and the next tick rebuilds it -- so an older
-- build that does not know them simply ignores them, while a version bump
-- would make the RUNNING service throw on restart against a db it wrote
-- itself. Additive cache tables do not earn that.
CREATE TABLE IF NOT EXISTS debrief_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload_json TEXT NOT NULL,
  inputs_hash TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);

-- The narrative lives in its own row on its own slower cadence, so a
-- narrative one tick stale survives a structural recompute instead of being
-- clobbered to NULL every 60s. Same separation, same reasoning, as
-- book.merge_tree_checked_at versus the main tick's upsert.
CREATE TABLE IF NOT EXISTS debrief_narrative (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  text TEXT NOT NULL,
  model TEXT NOT NULL,
  inputs_hash TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);
`;

export interface DelegationRow {
  id: string;
  conversation_id: string | null;
  state: DelegationState;
  contract_revision: number;
  contract_hash: string;
  brief_json: string;
  dispatch_json: string | null;
  repo: string;
  target_ref: string;
  baseline_sha: string;
  attempt_count: number;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface RunRow {
  id: string;
  delegation_id: string | null;
  kind: "worker" | "judge" | "brain" | "integration";
  attempt_number: number | null;
  provider: string;
  model: string | null;
  state: "running" | "succeeded" | "failed" | "timeout" | "cancelled" | "unknown";
  barry_session_id: string | null;
  provider_session_id: string | null;
  pid: number | null;
  pid_started_at: string | null;
  usage_json: string | null;
  failure_reason: string | null;
  deadline_at: number | null;
  started_at: number;
  ended_at: number | null;
}

export class PointGuardStore {
  readonly db: Database.Database;

  constructor(dbPath = pointGuardDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    if (!row) {
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)")
        .run(String(SCHEMA_VERSION));
    } else if (Number(row.value) !== SCHEMA_VERSION) {
      // v1 is the only version; a mismatch means a NEWER db than this
      // code. Refusing beats guessing at a schema we do not understand.
      throw new Error(
        `point-guard.db schema_version ${row.value} != supported ${SCHEMA_VERSION}`,
      );
    }
  }

  close(): void {
    this.db.close();
  }

  now(): number {
    return Date.now();
  }

  newId(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ------------------------------------------------------------------ events

  emitEvent(type: string, payload: Record<string, unknown>): number {
    const id = this.newId("ev");
    const info = this.db
      .prepare(
        "INSERT INTO stream_events (id, type, payload_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(id, type, JSON.stringify(payload), this.now());
    return Number(info.lastInsertRowid);
  }

  eventsAfter(cursor: number, limit = 500): Array<{ cursor: number; id: string; type: string; payload: unknown; createdAt: number }> {
    const rows = this.db
      .prepare(
        "SELECT cursor, id, type, payload_json, created_at FROM stream_events WHERE cursor > ? ORDER BY cursor ASC LIMIT ?",
      )
      .all(cursor, limit) as Array<{ cursor: number; id: string; type: string; payload_json: string; created_at: number }>;
    return rows.map((r) => ({
      cursor: r.cursor,
      id: r.id,
      type: r.type,
      payload: JSON.parse(r.payload_json),
      createdAt: r.created_at,
    }));
  }

  /** The most recent N events, oldest first -- what a message-context
   * snapshot wants ("what just happened"), distinct from eventsAfter's
   * cursor-based replay (what a WS client resuming from a known point
   * wants). */
  recentEvents(limit = 20): Array<{ cursor: number; id: string; type: string; payload: unknown; createdAt: number }> {
    const rows = this.db
      .prepare("SELECT cursor, id, type, payload_json, created_at FROM stream_events ORDER BY cursor DESC LIMIT ?")
      .all(limit) as Array<{ cursor: number; id: string; type: string; payload_json: string; created_at: number }>;
    return rows
      .map((r) => ({
        cursor: r.cursor,
        id: r.id,
        type: r.type,
        payload: JSON.parse(r.payload_json),
        createdAt: r.created_at,
      }))
      .reverse();
  }

  latestCursor(): number {
    const row = this.db.prepare("SELECT MAX(cursor) AS c FROM stream_events").get() as { c: number | null };
    return row.c ?? 0;
  }

  // ------------------------------------------------------------- delegations

  createDelegation(input: {
    conversationId?: string;
    brief: DelegationBrief;
    briefJson: string;
    contractHash: string;
    baselineSha: string;
    dispatchJson?: string;
  }): DelegationRow {
    const id = this.newId("dg");
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO delegations
           (id, conversation_id, state, contract_hash, brief_json, repo, target_ref, baseline_sha, dispatch_json, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.conversationId ?? null,
        input.contractHash,
        input.briefJson,
        input.brief.repo,
        input.brief.targetRef,
        input.baselineSha,
        input.dispatchJson ?? null,
        now,
        now,
      );
    this.emitEvent("delegation.created", { delegationId: id, state: "queued" });
    return this.getDelegation(id)!;
  }

  getDelegation(id: string): DelegationRow | undefined {
    return this.db.prepare("SELECT * FROM delegations WHERE id = ?").get(id) as
      | DelegationRow
      | undefined;
  }

  listDelegations(filter?: { state?: DelegationState; limit?: number }): DelegationRow[] {
    const limit = filter?.limit ?? 100;
    if (filter?.state) {
      return this.db
        .prepare("SELECT * FROM delegations WHERE state = ? ORDER BY updated_at DESC LIMIT ?")
        .all(filter.state, limit) as DelegationRow[];
    }
    return this.db
      .prepare("SELECT * FROM delegations ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as DelegationRow[];
  }

  /**
   * Guarded transition. Returns false when the row was not in `from` — the
   * caller must treat that as "someone else won", never force the write.
   */
  transitionDelegation(
    id: string,
    from: DelegationState | DelegationState[],
    to: DelegationState,
    reason?: string,
  ): boolean {
    const fromStates = Array.isArray(from) ? from : [from];
    for (const f of fromStates) {
      if (!DELEGATION_TRANSITIONS[f]?.includes(to)) {
        throw new Error(`illegal transition ${f} -> ${to} for delegation ${id}`);
      }
    }
    const placeholders = fromStates.map(() => "?").join(",");
    const info = this.db
      .prepare(
        `UPDATE delegations SET state = ?, reason = ?, updated_at = ?
         WHERE id = ? AND state IN (${placeholders})`,
      )
      .run(to, reason ?? null, this.now(), id, ...fromStates);
    const changed = info.changes === 1;
    if (changed) this.emitEvent("delegation.state", { delegationId: id, state: to, reason: reason ?? null });
    return changed;
  }

  incrementAttempts(id: string): number {
    this.db
      .prepare("UPDATE delegations SET attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?")
      .run(this.now(), id);
    return (this.getDelegation(id)?.attempt_count ?? 0);
  }

  // -------------------------------------------------------------------- runs

  createRun(input: {
    delegationId?: string;
    kind: RunRow["kind"];
    attemptNumber?: number;
    provider: string;
    model?: string;
    barrySessionId?: string;
    pid?: number;
    pidStartedAt?: string;
    deadlineAt?: number;
  }): string {
    const id = this.newId("run");
    this.db
      .prepare(
        `INSERT INTO runs (id, delegation_id, kind, attempt_number, provider, model, state, barry_session_id, pid, pid_started_at, deadline_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.delegationId ?? null,
        input.kind,
        input.attemptNumber ?? null,
        input.provider,
        input.model ?? null,
        input.barrySessionId ?? null,
        input.pid ?? null,
        input.pidStartedAt ?? null,
        input.deadlineAt ?? null,
        this.now(),
      );
    return id;
  }

  setRunProviderSession(runId: string, providerSessionId: string): void {
    this.db
      .prepare("UPDATE runs SET provider_session_id = ? WHERE id = ?")
      .run(providerSessionId, runId);
  }

  /** Terminal-only; a run never leaves a terminal state. `unknown` is a real
   * outcome (plan invariant #1) — recovery marks it, reconciliation resolves it. */
  finishRun(
    runId: string,
    state: Exclude<RunRow["state"], "running">,
    detail?: { usage?: unknown; failureReason?: string },
  ): boolean {
    const info = this.db
      .prepare(
        `UPDATE runs SET state = ?, usage_json = ?, failure_reason = ?, ended_at = ?
         WHERE id = ? AND state = 'running'`,
      )
      .run(
        state,
        detail?.usage !== undefined ? JSON.stringify(detail.usage) : null,
        detail?.failureReason ?? null,
        this.now(),
        runId,
      );
    return info.changes === 1;
  }

  runningRuns(): RunRow[] {
    return this.db.prepare("SELECT * FROM runs WHERE state = 'running'").all() as RunRow[];
  }

  runsForDelegation(delegationId: string): RunRow[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE delegation_id = ? ORDER BY started_at ASC")
      .all(delegationId) as RunRow[];
  }

  // ---------------------------------------------------------------- evidence

  addEvidence(input: {
    delegationId: string;
    runId?: string;
    candidateSha: string;
    contractHash: string;
    kind: "report" | "mechanical" | "judge" | "diff" | "integration-mechanical" | "integration-judge";
    payload: unknown;
  }): string {
    const id = this.newId("evd");
    const json = JSON.stringify(input.payload);
    const sha = createHash("sha256").update(json).digest("hex");
    this.db
      .prepare(
        `INSERT INTO evidence (id, delegation_id, run_id, candidate_sha, contract_hash, kind, payload_json, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.delegationId, input.runId ?? null, input.candidateSha, input.contractHash, input.kind, json, sha, this.now());
    return id;
  }

  evidenceFor(delegationId: string, kind?: string): Array<{ id: string; kind: string; candidate_sha: string; contract_hash: string; payload: unknown; created_at: number }> {
    const rows = (kind
      ? this.db
          .prepare("SELECT * FROM evidence WHERE delegation_id = ? AND kind = ? ORDER BY created_at ASC")
          .all(delegationId, kind)
      : this.db
          .prepare("SELECT * FROM evidence WHERE delegation_id = ? ORDER BY created_at ASC")
          .all(delegationId)) as Array<{ id: string; kind: string; candidate_sha: string; contract_hash: string; payload_json: string; created_at: number }>;
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload_json) }));
  }

  // -------------------------------------------------------------- merge queue

  enqueueMerge(input: {
    delegationId: string;
    repoCommonDir: string;
    targetRef: string;
    acceptedSha: string;
  }): string {
    // UNIQUE(delegation_id) makes re-enqueue idempotent: the second call finds
    // the row instead of duplicating the work.
    const existing = this.db
      .prepare("SELECT id FROM merge_queue WHERE delegation_id = ?")
      .get(input.delegationId) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = this.newId("mq");
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO merge_queue (id, delegation_id, repo_common_dir, target_ref, accepted_sha, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(id, input.delegationId, input.repoCommonDir, input.targetRef, input.acceptedSha, now, now);
    this.emitEvent("merge.enqueued", { delegationId: input.delegationId, queueId: id });
    return id;
  }

  /**
   * Claim the next queued entry for a target — but only when nothing else is
   * in flight for that (repo, ref). Integration is serialized per target
   * (plan invariant #4); the WHERE NOT EXISTS is the serialization.
   */
  claimNextMerge(repoCommonDir: string, targetRef: string): { id: string; delegation_id: string; accepted_sha: string } | undefined {
    return this.tx(() => {
      const inFlight = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM merge_queue WHERE repo_common_dir = ? AND target_ref = ? AND state IN ('claimed','integrated','publishing')",
        )
        .get(repoCommonDir, targetRef) as { n: number };
      if (inFlight.n > 0) return undefined;
      const next = this.db
        .prepare(
          "SELECT id, delegation_id, accepted_sha FROM merge_queue WHERE repo_common_dir = ? AND target_ref = ? AND state = 'queued' ORDER BY created_at ASC LIMIT 1",
        )
        .get(repoCommonDir, targetRef) as { id: string; delegation_id: string; accepted_sha: string } | undefined;
      if (!next) return undefined;
      const info = this.db
        .prepare("UPDATE merge_queue SET state = 'claimed', updated_at = ? WHERE id = ? AND state = 'queued'")
        .run(this.now(), next.id);
      return info.changes === 1 ? next : undefined;
    });
  }

  updateMerge(id: string, fields: Partial<{ observed_target_sha: string; integrated_sha: string; state: string; reason: string; publication_intent_at: number; published_at: number }>): void {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    this.db
      .prepare(`UPDATE merge_queue SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => (fields as Record<string, unknown>)[k]), this.now(), id);
  }

  getMerge(id: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM merge_queue WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  }

  mergesInState(states: string[]): Array<Record<string, unknown>> {
    const placeholders = states.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM merge_queue WHERE state IN (${placeholders})`)
      .all(...states) as Array<Record<string, unknown>>;
  }

  /**
   * Distinct (repo, targetRef) pairs with at least one QUEUED merge —
   * i.e. re-queued by recoverPublishing()/reconcileOnStartup() or simply
   * still waiting. One `processNext` call per target drains that target's
   * whole queue (it claims-and-serializes internally); this is only the
   * "which targets have work" query so a resume pass knows what to kick.
   */
  queuedMergeTargets(): Array<{ repoCommonDir: string; targetRef: string }> {
    return this.db
      .prepare(
        "SELECT DISTINCT repo_common_dir AS repoCommonDir, target_ref AS targetRef FROM merge_queue WHERE state = 'queued'",
      )
      .all() as Array<{ repoCommonDir: string; targetRef: string }>;
  }

  /**
   * Merge-queue rows stuck `claimed`/`integrated` whose delegation is no
   * longer `integrating` — i.e. reconcileOnStartup already moved the
   * delegation back to `queued`/`blocked`, but its OLD queue row is still
   * sitting in an in-flight state. claimNextMerge's WHERE NOT EXISTS
   * (above) treats claimed/integrated as occupying the target's one slot,
   * so an orphaned row here permanently starves every future merge to that
   * (repo, targetRef) until reclaimed. This is that reclaim query.
   */
  staleClaimedMerges(): Array<{ id: string; delegation_id: string; repo_common_dir: string; target_ref: string }> {
    return this.db
      .prepare(
        `SELECT mq.id, mq.delegation_id, mq.repo_common_dir, mq.target_ref
         FROM merge_queue mq
         JOIN delegations d ON d.id = mq.delegation_id
         WHERE mq.state IN ('claimed','integrated') AND d.state != 'integrating'`,
      )
      .all() as Array<{ id: string; delegation_id: string; repo_common_dir: string; target_ref: string }>;
  }

  /**
   * The barrySessionIds whose worktree must survive a prune pass: any run
   * belonging to a delegation that is NOT in a terminal state (merged,
   * cancelled, or failed-with-no-retry-left is still "terminal enough" —
   * conservatively, anything not merged/cancelled is kept, since acceptance
   * alone is not permission to destroy an unexamined worktree, and a
   * `blocked` delegation may still need its evidence's worktree for human
   * review). Scoped to one repo so a multi-repo deployment doesn't retain
   * every session ever run everywhere.
   */
  liveWorktreeSessionIds(repo: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT r.barry_session_id AS id
         FROM runs r
         JOIN delegations d ON d.id = r.delegation_id
         WHERE d.repo = ? AND d.state NOT IN ('merged', 'cancelled')
           AND r.barry_session_id IS NOT NULL`,
      )
      .all(repo) as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  }

  /** Distinct repos with any non-terminal delegation — what a startup prune
   * pass needs to iterate (one prune call per repo, not a global scan). */
  activeRepos(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT repo FROM delegations WHERE state NOT IN ('merged', 'cancelled')")
      .all() as Array<{ repo: string }>;
    return rows.map((r) => r.repo);
  }

  // ------------------------------------------------------------------ plans

  /**
   * Idempotent on planId: a re-submitted identical plan returns the
   * existing plan's id and step rows rather than duplicating dispatched
   * work — the same discipline enqueueMerge already applies to merge-queue
   * rows. When no planId is given, one is minted (single-shot submission,
   * nothing to be idempotent against).
   */
  intakePlan(plan: { planId?: string; repo: string; targetRef: string; steps: Array<{ id: string }> }, stepsJson: string): { planId: string; created: boolean } {
    if (plan.planId) {
      const existing = this.db.prepare("SELECT id FROM plans WHERE id = ?").get(plan.planId) as { id: string } | undefined;
      if (existing) return { planId: existing.id, created: false };
    }
    const planId = plan.planId ?? this.newId("plan");
    const now = this.now();
    this.tx(() => {
      this.db
        .prepare("INSERT INTO plans (id, repo, target_ref, steps_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(planId, plan.repo, plan.targetRef, stepsJson, now);
      for (const step of plan.steps) {
        this.db
          .prepare("INSERT INTO plan_steps (plan_id, step_id, status, updated_at) VALUES (?, ?, 'queued', ?)")
          .run(planId, step.id, now);
      }
    });
    this.emitEvent("plan.submitted", { planId, stepCount: plan.steps.length });
    return { planId, created: true };
  }

  getPlan(planId: string): { id: string; repo: string; target_ref: string; steps_json: string; created_at: number } | undefined {
    return this.db.prepare("SELECT * FROM plans WHERE id = ?").get(planId) as
      | { id: string; repo: string; target_ref: string; steps_json: string; created_at: number }
      | undefined;
  }

  planSteps(planId: string): Array<{ plan_id: string; step_id: string; delegation_id: string | null; status: PlanStepStatus; retrospective_json: string | null; updated_at: number }> {
    return this.db
      .prepare("SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY step_id ASC")
      .all(planId) as Array<{ plan_id: string; step_id: string; delegation_id: string | null; status: PlanStepStatus; retrospective_json: string | null; updated_at: number }>;
  }

  /**
   * Every open (not-terminal-anywhere) plan, for the recitation rollup.
   * "Open" = at least one step not yet done/skipped/failed.
   */
  openPlans(limit = 30): Array<{ id: string; repo: string; target_ref: string }> {
    return this.db
      .prepare(
        `SELECT DISTINCT p.id, p.repo, p.target_ref
         FROM plans p
         JOIN plan_steps ps ON ps.plan_id = p.id
         WHERE ps.status IN ('queued', 'in_progress')
         ORDER BY p.created_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{ id: string; repo: string; target_ref: string }>;
  }

  /** A step is runnable when it is still `queued` AND every step it
   * dependsOn (per the frozen plan JSON, not a live join) is `done`. Steps
   * already `in_progress`/terminal are never returned — this is purely the
   * "what can start right now" query, called again after every step
   * settles so newly-unblocked dependents fan out immediately. */
  nextRunnableSteps(planId: string): PlanStep[] {
    const plan = this.getPlan(planId);
    if (!plan) return [];
    const steps = JSON.parse(plan.steps_json) as PlanStep[];
    const statusById = new Map(this.planSteps(planId).map((row) => [row.step_id, row.status]));
    return steps.filter((step) => {
      if (statusById.get(step.id) !== "queued") return false;
      return step.dependsOn.every((dep) => statusById.get(dep) === "done");
    });
  }

  /** Guarded like transitionDelegation: only moves from an expected status,
   * first writer wins. Setting a delegation_id happens exactly once, at
   * dispatch — this call and that assignment are the SAME write so a step
   * is never "in_progress" with no delegation to check. */
  claimPlanStep(planId: string, stepId: string, delegationId: string): boolean {
    const info = this.db
      .prepare(
        "UPDATE plan_steps SET status = 'in_progress', delegation_id = ?, updated_at = ? WHERE plan_id = ? AND step_id = ? AND status = 'queued'",
      )
      .run(delegationId, this.now(), planId, stepId);
    return info.changes === 1;
  }

  settlePlanStep(planId: string, stepId: string, status: Extract<PlanStepStatus, "done" | "failed" | "skipped">, retrospective?: { summary: string; limitations: string }): void {
    this.db
      .prepare(
        "UPDATE plan_steps SET status = ?, retrospective_json = ?, updated_at = ? WHERE plan_id = ? AND step_id = ?",
      )
      .run(status, retrospective ? JSON.stringify(retrospective) : null, this.now(), planId, stepId);
    this.emitEvent("plan.step.settled", { planId, stepId, status });
  }

  /** The delegation_id a running step points at, if any — used to look up
   * its outcome (report/eligibility) when the scheduler's cycle for it
   * settles, so the plan-execution engine knows what to do next. */
  planStepForDelegation(delegationId: string): { plan_id: string; step_id: string } | undefined {
    return this.db
      .prepare("SELECT plan_id, step_id FROM plan_steps WHERE delegation_id = ?")
      .get(delegationId) as { plan_id: string; step_id: string } | undefined;
  }

  /**
   * Steps that are `in_progress` (already claimed, pointing at a real
   * delegation) whose delegation is sitting `queued` right now — i.e. its
   * attempt failed and requeued (the normal retry ladder), or Part 1's
   * reconcileOnStartup requeued it after a crash, and nothing has called
   * runCycle for it since. runPlan's nextRunnableSteps only ever sees
   * `queued` STEPS (a step never in flight yet), so this is the other half
   * of "what needs a cycle kicked" — a step already claimed whose
   * delegation stalled.
   */
  stalledInProgressSteps(planId: string): Array<{ step_id: string; delegation_id: string }> {
    return this.db
      .prepare(
        `SELECT ps.step_id, ps.delegation_id
         FROM plan_steps ps
         JOIN delegations d ON d.id = ps.delegation_id
         WHERE ps.plan_id = ? AND ps.status = 'in_progress' AND d.state = 'queued'`,
      )
      .all(planId) as Array<{ step_id: string; delegation_id: string }>;
  }

  // ---------------------------------------------------------- chat & memory

  ensureConversation(id: string, repo?: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO conversations (id, repo, created_at) VALUES (?, ?, ?)")
      .run(id, repo ?? null, this.now());
  }

  /** Returns the stored message id; a replayed requestId returns the original
   * row instead of inserting (idempotent writes, plan invariant #7). */
  appendChat(conversationId: string, role: "user" | "brain" | "system", content: string, requestId?: string): { id: string; sequence: number; deduped: boolean } {
    return this.tx(() => {
      if (requestId) {
        const existing = this.db
          .prepare("SELECT id, sequence FROM chat_messages WHERE request_id = ?")
          .get(requestId) as { id: string; sequence: number } | undefined;
        if (existing) return { ...existing, deduped: true };
      }
      const seqRow = this.db
        .prepare("SELECT COALESCE(MAX(sequence), 0) AS s FROM chat_messages WHERE conversation_id = ?")
        .get(conversationId) as { s: number };
      const id = this.newId("msg");
      const sequence = seqRow.s + 1;
      this.db
        .prepare(
          "INSERT INTO chat_messages (id, conversation_id, role, content, request_id, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, conversationId, role, content, requestId ?? null, sequence, this.now());
      this.emitEvent("chat.message", { conversationId, id, role, sequence });
      return { id, sequence, deduped: false };
    });
  }

  chatHistory(conversationId: string, afterSequence = 0, limit = 500): Array<{ id: string; role: string; content: string; sequence: number; created_at: number }> {
    return this.db
      .prepare(
        "SELECT id, role, content, sequence, created_at FROM chat_messages WHERE conversation_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?",
      )
      .all(conversationId, afterSequence, limit) as Array<{ id: string; role: string; content: string; sequence: number; created_at: number }>;
  }

  /**
   * The newest `limit` messages, in chronological order. `chatHistory(id, 0,
   * N)` returns the OLDEST N — correct for "replay from a point", wrong for
   * "rebuild recent context after a restart". A same-day conversation past N
   * messages needs THIS one, or the rebuild silently drops the tail — the
   * part of the conversation that matters most for resuming where it left
   * off. Implemented as DESC-then-reverse rather than a window function, to
   * keep this readable without assuming a SQLite version with them.
   */
  recentChatHistory(conversationId: string, limit = 40): Array<{ id: string; role: string; content: string; sequence: number; created_at: number }> {
    const rows = this.db
      .prepare(
        "SELECT id, role, content, sequence, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY sequence DESC LIMIT ?",
      )
      .all(conversationId, limit) as Array<{ id: string; role: string; content: string; sequence: number; created_at: number }>;
    return rows.reverse();
  }

  /** Total message count for a conversation — used to detect whether
   * `recentChatHistory`'s window actually cut anything off, so the caller
   * knows whether there's an "older than the window" tail to compact rather
   * than silently drop (Part 2's compaction hooks into this). */
  chatMessageCount(conversationId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id = ?")
      .get(conversationId) as { n: number };
    return row.n;
  }

  /** The highest `through_sequence` already covered by a summary — the
   * watermark compaction checks before doing more work, so the same
   * overflow window isn't re-summarized every turn. */
  latestSummaryThroughSequence(conversationId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(through_sequence), 0) AS s FROM summaries WHERE conversation_id = ?")
      .get(conversationId) as { s: number };
    return row.s;
  }

  /** The most recent summary's content for a conversation — everything
   * before the recent-N rebuild window, compacted into one durable record. */
  latestSummary(conversationId: string): string | undefined {
    const row = this.db
      .prepare("SELECT content FROM summaries WHERE conversation_id = ? ORDER BY through_sequence DESC LIMIT 1")
      .get(conversationId) as { content: string } | undefined;
    return row?.content;
  }

  recordSummary(conversationId: string, throughSequence: number, content: string): string {
    const id = this.newId("sum");
    this.db
      .prepare("INSERT INTO summaries (id, conversation_id, through_sequence, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, conversationId, throughSequence, content, this.now());
    return id;
  }

  /** Messages strictly between two sequence numbers — the "overflow" window
   * that fell outside recentChatHistory's rebuild window and has not yet
   * been covered by a summary. */
  chatHistoryBetween(conversationId: string, afterSequence: number, beforeSequence: number): Array<{ role: string; content: string; sequence: number }> {
    return this.db
      .prepare(
        "SELECT role, content, sequence FROM chat_messages WHERE conversation_id = ? AND sequence > ? AND sequence < ? ORDER BY sequence ASC",
      )
      .all(conversationId, afterSequence, beforeSequence) as Array<{ role: string; content: string; sequence: number }>;
  }

  upsertMemory(kind: "core" | "archive", content: string, id?: string): string {
    const now = this.now();
    if (id) {
      this.db.prepare("UPDATE memory SET content = ?, updated_at = ? WHERE id = ?").run(content, now, id);
      return id;
    }
    const newId = this.newId("mem");
    this.db
      .prepare("INSERT INTO memory (id, kind, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(newId, kind, content, now, now);
    return newId;
  }

  coreMemory(): Array<{ id: string; content: string }> {
    return this.db
      .prepare("SELECT id, content FROM memory WHERE kind = 'core' ORDER BY created_at ASC")
      .all() as Array<{ id: string; content: string }>;
  }

  // ----------------------------------------------------------------- ledger

  recordLedger(input: {
    delegationId?: string;
    runId?: string;
    kind: string;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
    note?: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO ledger (id, delegation_id, run_id, kind, input_tokens, output_tokens, estimated_cost_usd, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        this.newId("led"),
        input.delegationId ?? null,
        input.runId ?? null,
        input.kind,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.estimatedCostUsd ?? null,
        input.note ?? null,
        this.now(),
      );
  }

  ledgerFor(delegationId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM ledger WHERE delegation_id = ? ORDER BY created_at ASC")
      .all(delegationId) as Array<Record<string, unknown>>;
  }

  // ----------------------------------------------------------------- outbox

  enqueueOutbox(kind: string, payload: unknown): string {
    const id = this.newId("out");
    this.db
      .prepare("INSERT INTO outbox (id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)")
      .run(id, kind, JSON.stringify(payload), this.now());
    return id;
  }

  pendingOutbox(limit = 50): Array<{ id: string; kind: string; payload: unknown; attempts: number }> {
    const rows = this.db
      .prepare("SELECT id, kind, payload_json, attempts FROM outbox WHERE delivered_at IS NULL ORDER BY created_at ASC LIMIT ?")
      .all(limit) as Array<{ id: string; kind: string; payload_json: string; attempts: number }>;
    return rows.map((r) => ({ id: r.id, kind: r.kind, payload: JSON.parse(r.payload_json), attempts: r.attempts }));
  }

  markOutboxDelivered(id: string): void {
    this.db.prepare("UPDATE outbox SET delivered_at = ? WHERE id = ?").run(this.now(), id);
  }

  markOutboxFailed(id: string, error: string): void {
    this.db
      .prepare("UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?")
      .run(error, id);
  }

  // -------------------------------------------------------------- the book

  /**
   * Write (insert or replace) one session's book row. Called once per
   * session per supervisor tick with a freshly computed status -- a status
   * this call does not mention is not "preserved", it is simply not this
   * tick's finding; the caller is expected to pass its full current
   * verdict every time; pruneBookRows (below) is what removes a row for a
   * session that stopped being watched.
   */
  upsertBookRow(row: {
    sessionId: string;
    repo: string | null;
    branch: string | null;
    worktree: string | null;
    lastActivityAt: number | null;
    status: "ok" | "stuck" | "conflicted";
    flaggedReason: string | null;
  }): void {
    // merge_tree_checked_at is deliberately NOT in this statement's SET
    // clause -- the main tick (60s) upserts every session every pass, but
    // the merge-tree backstop runs on its own, longer interval. If this
    // upsert touched that column, every regular tick would either clobber
    // it back to NULL or need to thread the prior value through, and the
    // column would stop meaning "when did the SLOW check last run".
    // recordMergeTreeCheck (below) is the only writer of that column.
    this.db
      .prepare(
        `INSERT INTO book (session_id, repo, branch, worktree, last_activity_at, status, flagged_reason, updated_at)
         VALUES (@sessionId, @repo, @branch, @worktree, @lastActivityAt, @status, @flaggedReason, @updatedAt)
         ON CONFLICT(session_id) DO UPDATE SET
           repo = excluded.repo,
           branch = excluded.branch,
           worktree = excluded.worktree,
           last_activity_at = excluded.last_activity_at,
           status = excluded.status,
           flagged_reason = excluded.flagged_reason,
           updated_at = excluded.updated_at`,
      )
      .run({
        sessionId: row.sessionId,
        repo: row.repo,
        branch: row.branch,
        worktree: row.worktree,
        lastActivityAt: row.lastActivityAt,
        status: row.status,
        flaggedReason: row.flaggedReason,
        updatedAt: this.now(),
      });
  }

  /**
   * Record that the merge-tree backstop ran for a session, and optionally
   * escalate its status/reason if the backstop found what the real-time
   * tier missed. Never called from the main tick's upsert path -- see the
   * comment on upsertBookRow. A session absent from the book (never
   * upserted this run) silently no-ops rather than inserting a partial
   * row; the main tick is the only writer of a session's FIRST row.
   */
  recordMergeTreeCheck(sessionId: string, options?: { escalateStatus?: "conflicted"; flaggedReason?: string }): void {
    if (options?.escalateStatus) {
      this.db
        .prepare(
          `UPDATE book SET merge_tree_checked_at = ?, status = ?, flagged_reason = ? WHERE session_id = ?`,
        )
        .run(this.now(), options.escalateStatus, options.flaggedReason ?? null, sessionId);
    } else {
      this.db.prepare(`UPDATE book SET merge_tree_checked_at = ? WHERE session_id = ?`).run(this.now(), sessionId);
    }
  }

  /** Every session currently in the book, most recently updated first. */
  bookRows(): Array<{
    sessionId: string;
    repo: string | null;
    branch: string | null;
    worktree: string | null;
    lastActivityAt: number | null;
    status: "ok" | "stuck" | "conflicted";
    flaggedReason: string | null;
    mergeTreeCheckedAt: number | null;
    updatedAt: number;
  }> {
    const rows = this.db
      .prepare("SELECT * FROM book ORDER BY updated_at DESC")
      .all() as Array<{
      session_id: string;
      repo: string | null;
      branch: string | null;
      worktree: string | null;
      last_activity_at: number | null;
      status: "ok" | "stuck" | "conflicted";
      flagged_reason: string | null;
      merge_tree_checked_at: number | null;
      updated_at: number;
    }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      repo: r.repo,
      branch: r.branch,
      worktree: r.worktree,
      lastActivityAt: r.last_activity_at,
      status: r.status,
      flaggedReason: r.flagged_reason,
      mergeTreeCheckedAt: r.merge_tree_checked_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Drop book rows for sessions the last tick did not see at all -- a
   * session that ended (or was never real) should disappear from the book,
   * not linger forever as a stale "ok" row. `keepSessionIds` is this
   * tick's full observed set; everything else in the table is gone now.
   */
  pruneBookRows(keepSessionIds: Set<string>): number {
    const existing = this.db.prepare("SELECT session_id FROM book").all() as Array<{ session_id: string }>;
    const toDrop = existing.map((r) => r.session_id).filter((id) => !keepSessionIds.has(id));
    if (toDrop.length === 0) return 0;
    const placeholders = toDrop.map(() => "?").join(",");
    this.db.prepare(`DELETE FROM book WHERE session_id IN (${placeholders})`).run(...toDrop);
    return toDrop.length;
  }

  // -------------------------------------------------------- messages_log

  /** Record one message/reply pair. Display-only -- never read back as
   * context for a future call (see the schema comment for why). */
  recordMessageLog(message: string, reply: string): string {
    const id = this.newId("msg");
    this.db
      .prepare("INSERT INTO messages_log (id, message, reply, created_at) VALUES (?, ?, ?, ?)")
      .run(id, message, reply, this.now());
    return id;
  }

  /** Most recent messages first -- pure scrollback for a human to read. */
  recentMessageLog(limit = 50): Array<{ id: string; message: string; reply: string; createdAt: number }> {
    const rows = this.db
      .prepare("SELECT id, message, reply, created_at FROM messages_log ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<{ id: string; message: string; reply: string; created_at: number }>;
    return rows.map((r) => ({ id: r.id, message: r.message, reply: r.reply, createdAt: r.created_at }));
  }

  /**
   * Undelivered outbox rows that have actually been TRIED (attempts > 0),
   * with the error. A row at attempts 0 is merely queued, not failing, and
   * reporting it as trouble would cry wolf on every normal enqueue.
   *
   * Separate from pendingOutbox rather than widening it: that shape is
   * consumed by /readiness, and changing a method's return type to suit a
   * new caller is how unrelated callers break.
   */
  failingOutbox(limit = 50): Array<{ id: string; attempts: number; lastError: string | null; createdAt: number }> {
    const rows = this.db
      .prepare(
        `SELECT id, attempts, last_error, created_at FROM outbox
         WHERE delivered_at IS NULL AND attempts > 0
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{ id: string; attempts: number; last_error: string | null; created_at: number }>;
    return rows.map((r) => ({ id: r.id, attempts: r.attempts, lastError: r.last_error, createdAt: r.created_at }));
  }

  // ------------------------------------------------------------- debrief

  /** Replace the cached debrief. One row, rewritten every tick. */
  putDebriefSnapshot(payloadJson: string, inputsHash: string): void {
    this.db
      .prepare(
        `INSERT INTO debrief_snapshot (id, payload_json, inputs_hash, generated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payload_json = excluded.payload_json,
           inputs_hash = excluded.inputs_hash,
           generated_at = excluded.generated_at`,
      )
      .run(payloadJson, inputsHash, this.now());
  }

  /** null = no tick has produced a debrief yet (fresh db, or the service has
   *  not completed a tick since boot). Distinct from a debrief that ran and
   *  found no sessions, which is a real payload with empty arrays. */
  debriefSnapshot(): { payloadJson: string; inputsHash: string; generatedAt: number } | null {
    const row = this.db
      .prepare("SELECT payload_json, inputs_hash, generated_at FROM debrief_snapshot WHERE id = 1")
      .get() as { payload_json: string; inputs_hash: string; generated_at: number } | undefined;
    return row
      ? { payloadJson: row.payload_json, inputsHash: row.inputs_hash, generatedAt: row.generated_at }
      : null;
  }

  putDebriefNarrative(text: string, model: string, inputsHash: string): void {
    this.db
      .prepare(
        `INSERT INTO debrief_narrative (id, text, model, inputs_hash, generated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           text = excluded.text,
           model = excluded.model,
           inputs_hash = excluded.inputs_hash,
           generated_at = excluded.generated_at`,
      )
      .run(text, model, inputsHash, this.now());
  }

  /** null = NO narrative has ever been generated (first boot, or every
   *  attempt has failed). Never a placeholder: the caller must be able to
   *  tell that from a narrative that exists and says little. */
  debriefNarrative(): { text: string; model: string; inputsHash: string; generatedAt: number } | null {
    const row = this.db
      .prepare("SELECT text, model, inputs_hash, generated_at FROM debrief_narrative WHERE id = 1")
      .get() as { text: string; model: string; inputs_hash: string; generated_at: number } | undefined;
    return row
      ? { text: row.text, model: row.model, inputsHash: row.inputs_hash, generatedAt: row.generated_at }
      : null;
  }
}
