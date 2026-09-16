/**
 * The debrief's prose overview.
 *
 * Three rules govern this file, and the first is the one that matters:
 *
 * 1. IT IS NEVER A SOURCE OF TRUTH. Every number a client shows comes from
 *    counts/sessions/trouble. This is prose ABOUT those fields. A client that
 *    renders the narrative where a measurement belongs is a bug, and a
 *    narrative that fails to generate must leave the debrief complete.
 *
 * 2. It runs on a slow tick and is cached, never generated per request.
 *    Clients poll on timers; a per-request model call would multiply every
 *    poll by every client. When the structured inputs have not changed, it
 *    does not regenerate at all -- an idle team costs nothing.
 *
 * 3. Local model, degrade to null. qwen3:4b through Ollama is free and its
 *    failure mode is already "return null, log, carry on" (compaction.ts).
 *    A paid model on a five-minute timer would bill whether or not anyone is
 *    looking, which is the wrong shape for an advisory field.
 */
import { ollamaChat as chat, ModelUnavailableError } from "@barry-rocks/agent-runtime";
import { createLogger } from "@barry-rocks/logger";
import type { Debrief, DebriefNarrative } from "./debrief.js";

const log = createLogger("point-guard:debrief-narrative");

export const NARRATIVE_MODEL = "qwen3:4b";
export const NARRATIVE_KEEP_ALIVE = "60s";

/**
 * The overclaim ban is not stylistic. "no textual conflict" versus "safe" is
 * a real distinction this codebase enforces in merge-tree-backstop.ts,
 * because git merge-tree proves the absence of a textual clash and nothing
 * more. A model writing "everything looks fine" would launder an
 * absence-of-evidence into a claim the system cannot make.
 */
const SYSTEM_PROMPT = `You summarize a supervisor's snapshot of concurrent coding sessions.

You are given counts, a per-session table, and a list of troubles. Describe only what is in the snapshot.

Never call a session "safe", "fine", "healthy", "done", or "on track" — you cannot observe any of those. A conflict check that found nothing means "no textual conflict was detected", never "no conflict exists". A session with no recorded trouble is "not flagged", not "working correctly".

Do not infer what a session is trying to achieve beyond its stated name and summary. Do not invent session names, counts, or events that are not in the snapshot.

Reply with two to four plain sentences. No headings, no lists, no preamble.`;

/** What the model is shown. Deliberately the structured fields only, trimmed:
 *  a model given raw rows tends to recite them back, and the client already
 *  renders the table. */
export function narrativePrompt(debrief: Debrief): string {
  const { counts } = debrief;
  const lines: string[] = [
    `Sessions: ${counts.total} total — ${counts.working} active in the last 10 minutes, ${counts.idle} quiet, ${counts.stuck} stuck, ${counts.conflicted} conflicted.`,
    "",
  ];

  if (debrief.sessions.length > 0) {
    lines.push("Sessions:");
    for (const s of debrief.sessions.slice(0, 25)) {
      const where = s.repoName ?? "no repo";
      const doing = s.latestSummary ? ` — ${s.latestSummary.replace(/\s+/g, " ").slice(0, 160)}` : "";
      const flag = s.status === "ok" ? "" : ` [${s.status}: ${s.flaggedReason ?? "no reason"}]`;
      lines.push(`- ${s.name} (${where})${flag}${doing}`);
    }
    lines.push("");
  }

  if (debrief.trouble.length > 0) {
    lines.push("Troubles:");
    for (const t of debrief.trouble.slice(0, 15)) {
      lines.push(`- ${t.kind}${t.sessionId ? ` (${t.sessionId.slice(0, 8)})` : ""}: ${t.detail}`);
    }
    lines.push("");
  } else {
    lines.push("Troubles: none recorded.");
    lines.push("");
  }

  if (debrief.plans.length > 0) {
    lines.push(`Open plans in these repos: ${debrief.plans.map((p) => p.title).slice(0, 10).join("; ")}`);
  }

  return lines.join("\n");
}

/**
 * Generate, or return null.
 *
 * Returns null on every failure path -- Ollama down, model absent, empty
 * output. The caller keeps whatever narrative it already had, so a transient
 * outage shows a stale narrative rather than blanking it, and a permanent one
 * shows none rather than blocking the debrief.
 */
export async function generateNarrative(
  debrief: Debrief,
  options?: { model?: string; baseUrl?: string },
): Promise<DebriefNarrative | null> {
  const model = options?.model ?? NARRATIVE_MODEL;
  try {
    const result = await chat({
      baseUrl: options?.baseUrl,
      model,
      keepAlive: NARRATIVE_KEEP_ALIVE,
      think: false,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: narrativePrompt(debrief) },
      ],
    });
    const text = result.content.trim();
    if (!text) {
      log.info("narrative skipped: model returned empty content");
      return null;
    }
    return { text, model, generatedAt: Date.now(), inputsHash: debrief.inputsHash };
  } catch (error) {
    if (error instanceof ModelUnavailableError) {
      log.info(`narrative skipped: ${error.message}`);
    } else {
      log.warn(`narrative generation failed: ${String(error)}`);
    }
    return null;
  }
}

/**
 * Whether to spend a model call this pass.
 *
 * Skips when the structured inputs are unchanged since the cached narrative
 * was written -- the prose would say the same thing, so an idle team costs
 * nothing at all rather than a call every five minutes forever.
 */
export function shouldRegenerate(current: Debrief, cached: DebriefNarrative | null): boolean {
  if (!cached) return true;
  return cached.inputsHash !== current.inputsHash;
}
