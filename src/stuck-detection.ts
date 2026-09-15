/**
 * Stuck-session detection: result-aware repeated tool-call hashing
 * (OpenHands' pattern). A session issuing the SAME (tool, args, result)
 * triple 3+ times in its recent window is flagged -- that's a session
 * making no forward progress, not one merely doing repetitive work.
 *
 * The result MUST be in the hash. Hashing only (tool, args) flags a
 * session polling a job's status every few seconds while it legitimately
 * runs -- same tool, same args, DIFFERENT result each time (still
 * pending, then done) -- which is exactly the false-positive this
 * pattern exists to avoid. A session stuck retrying the same failing
 * command gets the same result every time; a session making progress
 * (even via polling) does not.
 *
 * This distinguishes "quiet because it's finished" from "quiet because
 * it's wedged" only by what it can observe -- REPEATED IDENTICAL
 * ACTION+OUTCOME. It says nothing about a session that is merely idle
 * (no recent tool calls at all); that is the book's last_activity_at
 * field's job, not this one's. The two are different failure shapes and
 * this module only claims the one it actually checks.
 */
import { createHash } from "node:crypto";
import type { RecentToolCall } from "@barry-rocks/db";

/** 3 identical repeats is the threshold this pattern's prior art (OpenHands)
 * uses -- low enough to catch a stuck loop before it burns much more time,
 * high enough that two or three genuinely-coincidental identical calls
 * (e.g. "list the directory" twice while orienting) don't false-positive. */
export const STUCK_REPEAT_THRESHOLD = 3;

/** How far back to look per session. Bounded so a long-lived session's
 * ancient history never influences today's verdict -- stuck detection is
 * about the CURRENT tail of behavior, not a lifetime tally. */
export const STUCK_WINDOW_SIZE = 10;

export interface StuckVerdict {
  stuck: boolean;
  /** Present only when stuck: the repeated (tool, args, result) signature
   * and how many times it repeated, for a human-readable flagged_reason. */
  repeatedCall?: { tool: string; count: number };
}

/** A stable signature for one tool call: hash of (name, input, result) so
 * that two calls compare equal iff all three match. JSON.stringify's key
 * order is insertion order, not sorted -- fine here because both sides of
 * any real comparison come from the same tool implementation's own
 * consistent argument/result shape, not independently-constructed objects
 * that could differ only in key order. */
function callSignature(call: RecentToolCall): string {
  const payload = JSON.stringify({ name: call.name, input: call.input, result: call.result });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Evaluate one session's recent tool-call window. Pure function -- no I/O,
 * so the false-positive-resistance claim (identical tool+args with
 * DIFFERENT results never flags) is testable without a database.
 */
export function evaluateStuck(recentCalls: RecentToolCall[]): StuckVerdict {
  if (recentCalls.length === 0) return { stuck: false };

  const window = recentCalls.slice(0, STUCK_WINDOW_SIZE);
  const counts = new Map<string, { count: number; name: string }>();

  for (const call of window) {
    const sig = callSignature(call);
    const entry = counts.get(sig);
    if (entry) {
      entry.count += 1;
    } else {
      counts.set(sig, { count: 1, name: call.name ?? "unknown" });
    }
  }

  for (const entry of counts.values()) {
    if (entry.count >= STUCK_REPEAT_THRESHOLD) {
      return { stuck: true, repeatedCall: { tool: entry.name, count: entry.count } };
    }
  }

  return { stuck: false };
}
