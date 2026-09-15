/**
 * POST /message: the Heartbeat pattern (MindStudio) / context-reset pattern
 * (Anthropic) applied to point-guard. Each message is answered fresh from a
 * compact snapshot -- the book plus a short recent-event slice -- with ONE
 * model call. No persisted conversation, no chaining, no growing transcript
 * to manage or compact. messages_log (store.ts) records the pair for the
 * human's own scrollback only; it is never read back in as context.
 */
import { createLogger } from "@barry-rocks/logger";
import { resolveMessageCredentials } from "./message-key.js";
import type { PointGuardStore } from "./store.js";

const log = createLogger("point-guard:message");

const MODEL = "gpt-5.4-mini";
const RECENT_EVENTS_LIMIT = 20;

const SYSTEM_PROMPT = `You are point-guard, Barry's team supervisor. You watch Barry's active sessions (interactive claude/codex/etc sessions, and point-guard's own delegation workers) and answer questions about their state.

You are given a snapshot of the current book (one row per session: repo, branch, worktree, last activity, status) and a short list of recent events. This is ALL the context you have -- there is no prior conversation. Answer only from what's in the snapshot; do not invent sessions, statuses, or events not present in it. If the snapshot doesn't answer the question, say so plainly rather than guessing.

Keep replies short and direct -- this is a status ping, not a report.`;

export interface MessageResult {
  ok: true;
  reply: string;
}
export interface MessageError {
  ok: false;
  error: string;
}

function summarizeBookForPrompt(rows: ReturnType<PointGuardStore["bookRows"]>): string {
  if (rows.length === 0) return "(no sessions currently in the book)";
  return rows
    .map((r) => {
      const activity = r.lastActivityAt ? new Date(r.lastActivityAt).toISOString() : "no messages yet";
      const flag = r.flaggedReason ? ` -- ${r.flaggedReason}` : "";
      return `- ${r.sessionId.slice(0, 12)}: ${r.repo ?? "no repo"} (${r.branch ?? "no branch"}), last activity ${activity}, status=${r.status}${flag}`;
    })
    .join("\n");
}

function summarizeEventsForPrompt(events: ReturnType<PointGuardStore["recentEvents"]>): string {
  if (events.length === 0) return "(no recent events)";
  return events
    .map((e) => `- ${new Date(e.createdAt).toISOString()} ${e.type}: ${JSON.stringify(e.payload).slice(0, 200)}`)
    .join("\n");
}

/**
 * Handle one message: assemble a fresh snapshot, make one model call, log
 * the pair, return the reply. Every failure is named -- "messaging offline"
 * with no reason is a check that cannot fail distinguishably.
 */
export async function handleMessage(store: PointGuardStore, content: string): Promise<MessageResult | MessageError> {
  const credentials = await resolveMessageCredentials();
  if (!credentials.ok) {
    return { ok: false, error: `messaging offline: ${credentials.reason}` };
  }

  const book = store.bookRows();
  const events = store.recentEvents(RECENT_EVENTS_LIMIT);

  const userPrompt = `Current book (${book.length} session(s)):\n${summarizeBookForPrompt(book)}\n\nRecent events:\n${summarizeEventsForPrompt(events)}\n\nMessage: ${content}`;

  let reply: string;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `model call failed (${res.status}): ${body.slice(0, 500)}` };
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      return { ok: false, error: "model call returned no content" };
    }
    reply = text;
  } catch (error) {
    log.error(`message call failed: ${String(error)}`);
    return { ok: false, error: `model call failed: ${String(error)}` };
  }

  store.recordMessageLog(content, reply);
  return { ok: true, reply };
}
