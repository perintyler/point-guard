/**
 * The debrief's pure logic. Every test here is a rule a user would notice
 * breaking: a session mislabelled as working when it is idle, a four-day-old
 * session's opening summary shown as what it is doing now, or -- the one this
 * codebase cares most about -- a "never checked" rendered as "checked, fine".
 */
import { describe, it, expect } from "vitest";
import {
  WORKING_WINDOW_MS,
  SUMMARY_EXCERPT_CHARS,
  countSessions,
  hashDebriefInputs,
  latestSummaryEntry,
  repoDisplayName,
  type DebriefSession,
} from "../debrief.js";

const NOW = 1_800_000_000_000;

function session(over: Partial<DebriefSession> = {}): DebriefSession {
  return {
    sessionId: "s1",
    name: "a session",
    nameSource: "metadata",
    repo: "/Users/tyler/repos/barry/.git",
    repoName: "barry",
    branch: null,
    worktree: "/Users/tyler/repos/barry",
    lifecycleStatus: "running",
    status: "ok",
    flaggedReason: null,
    createdAt: NOW - 60_000,
    lastActivityAt: NOW - 1_000,
    aliveMs: 60_000,
    idleMs: 1_000,
    latestSummary: null,
    filesTouched: 0,
    mergeTreeCheckedAt: null,
    plans: [],
    ...over,
  };
}

describe("repoDisplayName", () => {
  it("names the repo, not its .git directory", () => {
    expect(repoDisplayName("/Users/tyler/repos/barry/.git")).toBe("barry");
  });

  it("handles a bare repo path with no .git suffix", () => {
    expect(repoDisplayName("/Users/tyler/repos/barry")).toBe("barry");
  });

  it("is null when there is no repo -- not an empty string a client would render", () => {
    expect(repoDisplayName(null)).toBeNull();
  });
});

describe("latestSummaryEntry", () => {
  it("takes the NEWEST entry, not the first", () => {
    // The bookkeeping job appends, so the head describes what the session was
    // doing days ago. Getting this backwards is silently wrong rather than
    // visibly broken, which is why it is tested.
    const log = "### 2026-09-11\nStarted on the parser.\n\n### 2026-09-15\nNow debugging the merge queue.";
    expect(latestSummaryEntry(log)).toBe("Now debugging the merge queue.");
  });

  it("returns null when the bookkeeping job has never summarized -- not an empty string", () => {
    expect(latestSummaryEntry(null)).toBeNull();
    expect(latestSummaryEntry("")).toBeNull();
    expect(latestSummaryEntry("   ")).toBeNull();
  });

  it("keeps a whole entry together when it has ### subsections of its own", () => {
    // The real format, copied from a live row. Each entry is headed by a
    // timestamp AND contains ### Done / ### Learnings at the same heading
    // level -- splitting on every ### returns only the last subsection and
    // silently drops the rest of what the session did.
    const real = [
      "### 2026-08-26 05:04",
      "",
      "### Done",
      "",
      "- Verified the row gap between transformed and loaded data",
      "",
      "### Learnings",
      "",
      "- The compare method uses absolute delta, not percentage",
    ].join("\n");
    const out = latestSummaryEntry(real)!;
    expect(out).toContain("Verified the row gap");
    expect(out).toContain("absolute delta");
    expect(out.startsWith("2026-08-26")).toBe(false);
  });

  it("handles a summary with no entry headers at all", () => {
    expect(latestSummaryEntry("just some prose")).toBe("just some prose");
  });

  it("truncates a long entry rather than shipping a multi-day log", () => {
    const long = `### 2026-09-15\n${"x".repeat(SUMMARY_EXCERPT_CHARS + 200)}`;
    const out = latestSummaryEntry(long);
    expect(out!.length).toBeLessThanOrEqual(SUMMARY_EXCERPT_CHARS + 1); // +1 for the ellipsis
    expect(out!.endsWith("…")).toBe(true);
  });
});

describe("countSessions", () => {
  it("counts a recently-active ok session as working", () => {
    const counts = countSessions([session({ lastActivityAt: NOW - 1_000 })], NOW);
    expect(counts).toMatchObject({ total: 1, working: 1, idle: 0 });
  });

  it("counts a quiet ok session as idle, not working", () => {
    const counts = countSessions([session({ lastActivityAt: NOW - WORKING_WINDOW_MS - 1 })], NOW);
    expect(counts).toMatchObject({ total: 1, working: 0, idle: 1 });
  });

  it("counts a session with NO activity at all as idle, never working", () => {
    // null here means "has produced zero messages", which is not the same as
    // "was active a long time ago" -- but both are idle, not working.
    const counts = countSessions([session({ lastActivityAt: null })], NOW);
    expect(counts).toMatchObject({ total: 1, working: 0, idle: 1 });
  });

  it("counts stuck and conflicted separately from idle, even when recently active", () => {
    const counts = countSessions(
      [
        session({ sessionId: "a", status: "stuck", flaggedReason: "repeated 3x", lastActivityAt: NOW }),
        session({ sessionId: "b", status: "conflicted", flaggedReason: "contended: x.ts", lastActivityAt: NOW }),
      ],
      NOW,
    );
    expect(counts).toMatchObject({ total: 2, working: 0, idle: 0, stuck: 1, conflicted: 1 });
  });

  it("totals always equal the row count -- the table and its headline cannot disagree", () => {
    const rows = [
      session({ sessionId: "a", lastActivityAt: NOW }),
      session({ sessionId: "b", lastActivityAt: null }),
      session({ sessionId: "c", status: "stuck", flaggedReason: "r" }),
      session({ sessionId: "d", status: "conflicted", flaggedReason: "r" }),
    ];
    const c = countSessions(rows, NOW);
    expect(c.working + c.idle + c.stuck + c.conflicted).toBe(c.total);
    expect(c.total).toBe(rows.length);
  });
});

describe("hashDebriefInputs", () => {
  const base = {
    counts: countSessions([session()], NOW),
    sessions: [session()],
    plans: [],
    trouble: [],
  };

  it("is stable across calls on identical content", () => {
    expect(hashDebriefInputs(base)).toBe(hashDebriefInputs(base));
  });

  it("changes when a session's status changes", () => {
    const changed = { ...base, sessions: [session({ status: "stuck", flaggedReason: "repeated 3x" })] };
    expect(hashDebriefInputs(changed)).not.toBe(hashDebriefInputs(base));
  });

  it("does NOT change on timestamps alone", () => {
    // The whole point: if elapsed time moved the hash, the narrative would
    // regenerate every tick forever and its stale marker would never mean
    // anything. An idle team must cost nothing.
    const later = {
      ...base,
      sessions: [session({ lastActivityAt: NOW + 30_000, idleMs: 0, aliveMs: 90_000 })],
    };
    expect(hashDebriefInputs(later)).toBe(hashDebriefInputs(base));
  });
});
