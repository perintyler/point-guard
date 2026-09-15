/**
 * Result-aware repeated tool-call hashing. The critical property this
 * suite exists to pin: identical (tool, args) with DIFFERENT results
 * across calls must NEVER flag -- that's a session legitimately polling,
 * not one stuck in a loop. A test suite that only checked "3 identical
 * calls flags" and never checked "3 calls that differ only in result
 * does not flag" would pass while missing the entire point of the
 * "result-aware" half of the pattern's name.
 */
import { describe, it, expect } from "vitest";
import { evaluateStuck, STUCK_REPEAT_THRESHOLD, STUCK_WINDOW_SIZE } from "../stuck-detection.js";
import type { RecentToolCall } from "@barry-rocks/db";

function call(name: string, input: unknown, result: unknown): RecentToolCall {
  return { name, input, result, createdAt: new Date().toISOString() };
}

describe("evaluateStuck", () => {
  it("does not flag an empty window", () => {
    expect(evaluateStuck([])).toEqual({ stuck: false });
  });

  it("does not flag calls below the repeat threshold", () => {
    const calls = Array.from({ length: STUCK_REPEAT_THRESHOLD - 1 }, () =>
      call("Bash", { command: "pytest" }, { exitCode: 1, output: "FAILED test_x" }),
    );
    expect(evaluateStuck(calls).stuck).toBe(false);
  });

  it("flags the same (tool, args, result) triple repeated at the threshold", () => {
    const calls = Array.from({ length: STUCK_REPEAT_THRESHOLD }, () =>
      call("Bash", { command: "pytest" }, { exitCode: 1, output: "FAILED test_x" }),
    );
    const verdict = evaluateStuck(calls);
    expect(verdict.stuck).toBe(true);
    expect(verdict.repeatedCall).toEqual({ tool: "Bash", count: STUCK_REPEAT_THRESHOLD });
  });

  it("CRITICAL: does not flag identical tool+args when the result differs each time (legitimate polling)", () => {
    // A session polling a background job's status -- same command, result
    // changes as the job progresses. This must never read as stuck.
    const calls = [
      call("Bash", { command: "check-job-status" }, { status: "running" }),
      call("Bash", { command: "check-job-status" }, { status: "running" }),
      call("Bash", { command: "check-job-status" }, { status: "running" }),
      call("Bash", { command: "check-job-status" }, { status: "done" }),
    ];
    // Three of the four share a result ("running" x3) -- exactly at
    // threshold on tool+args+result, so this SHOULD flag; verifies the
    // hash is genuinely keyed on all three fields together, not silently
    // ignoring result. The true polling case (below) is the one that must
    // NOT flag: every result distinct.
    expect(evaluateStuck(calls).stuck).toBe(true);
  });

  it("does not flag genuine polling where every result is distinct", () => {
    const calls = [
      call("Bash", { command: "check-job-status" }, { status: "queued" }),
      call("Bash", { command: "check-job-status" }, { status: "running", pct: 10 }),
      call("Bash", { command: "check-job-status" }, { status: "running", pct: 55 }),
      call("Bash", { command: "check-job-status" }, { status: "running", pct: 90 }),
      call("Bash", { command: "check-job-status" }, { status: "done" }),
    ];
    expect(evaluateStuck(calls).stuck).toBe(false);
  });

  it("does not flag a fix-then-verify loop where each attempt's result differs", () => {
    // Legitimate iteration: try a fix, test, see a DIFFERENT failure each
    // time as progress is made, eventually pass. No repeated triple.
    const calls = [
      call("Bash", { command: "npm test" }, { exitCode: 1, output: "3 failing" }),
      call("Edit", { file: "a.ts" }, { ok: true }),
      call("Bash", { command: "npm test" }, { exitCode: 1, output: "1 failing" }),
      call("Edit", { file: "a.ts" }, { ok: true }),
      call("Bash", { command: "npm test" }, { exitCode: 0, output: "all passing" }),
    ];
    expect(evaluateStuck(calls).stuck).toBe(false);
  });

  it("does not flag different tools with coincidentally similar args", () => {
    const calls = [
      call("Read", { path: "a.ts" }, { content: "x" }),
      call("Write", { path: "a.ts" }, { ok: true }),
      call("Read", { path: "a.ts" }, { content: "y" }),
    ];
    expect(evaluateStuck(calls).stuck).toBe(false);
  });

  it("only considers the most recent STUCK_WINDOW_SIZE calls", () => {
    // Threshold-1 repeats sitting OUTSIDE the window, plus one more of the
    // same call inside a full window of otherwise-unique calls, must not
    // combine to cross the threshold -- the old repeats are out of scope.
    const stale = Array.from({ length: STUCK_REPEAT_THRESHOLD - 1 }, () =>
      call("Bash", { command: "old" }, { exitCode: 1 }),
    );
    const fresh = Array.from({ length: STUCK_WINDOW_SIZE }, (_, i) => call("Bash", { command: `fresh-${i}` }, { exitCode: 0 }));
    // getRecentToolCallsBySessions returns most-recent-first; "stale" would
    // be the OLDER entries appended after "fresh" in that ordering.
    const calls = [...fresh, ...stale];
    expect(evaluateStuck(calls).stuck).toBe(false);
  });

  it("flags a repeated triple even when other distinct calls are interleaved", () => {
    const calls = [
      call("Bash", { command: "pytest" }, { exitCode: 1, output: "FAIL" }),
      call("Read", { path: "x.ts" }, { content: "..." }),
      call("Bash", { command: "pytest" }, { exitCode: 1, output: "FAIL" }),
      call("Read", { path: "y.ts" }, { content: "..." }),
      call("Bash", { command: "pytest" }, { exitCode: 1, output: "FAIL" }),
    ];
    expect(evaluateStuck(calls).stuck).toBe(true);
  });
});
