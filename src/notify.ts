/**
 * Notification on flagged book rows: emit an `events` row (the durable,
 * queryable record) AND shell out to `barry notify` (the "get a human's
 * attention" path) -- exactly the pattern bags/reminders' dispatcher
 * already uses for the same reason: one recurring process, not a
 * per-notification launchd job.
 */
import { spawnSync } from "node:child_process";
import { createLogger } from "@barry-rocks/logger";

const log = createLogger("point-guard:notify");

export function notify(message: string, channel: "slack" | "sms" = "slack"): { ok: boolean; error?: string } {
  const result = spawnSync("barry", ["notify", "--channel", channel, message], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    log.warn(`notify shell-out failed to start: ${result.error.message}`);
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "notify failed").trim().split("\n").pop();
    log.warn(`notify exited ${result.status}: ${detail}`);
    return { ok: false, error: detail };
  }
  return { ok: true };
}
