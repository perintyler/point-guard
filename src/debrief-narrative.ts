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
 * Wall-clock ceiling for one narrative call.
 *
 * Measured, not guessed: the real prompt took 54s on an idle machine and
 * 104s on a busy one, against the client's 120s default. That is close
 * enough to the edge that a loaded host crosses it and the call dies -- and
 * the client reports EVERY fetch rejection as "Ollama unreachable", so the
 * logs blame a server that is running fine. We set our own shorter budget
 * and say plainly in the log what a timeout actually was.
 */
export const NARRATIVE_TIMEOUT_MS = 90_000;

/**
 * Longest narrative we will store.
 *
 * The prompt asks for "two to four plain sentences"; qwen3:4b answered with
 * 5,681 characters of markdown tables and emoji headings (observed
 * 2026-09-15, after reasoning was already stripped). A prompt is a request,
 * not a constraint, so the constraint lives here. Over-long output is
 * DISCARDED rather than truncated: a narrative cut mid-table is not prose,
 * and the debrief is complete without it.
 */
export const NARRATIVE_MAX_CHARS = 1_200;

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
/**
 * Strip a reasoning model's thinking block.
 *
 * We pass `think: false`, but that is a REQUEST, not a guarantee -- qwen3
 * emitted a full `<think>` monologue through it anyway, and the whole
 * monologue landed in the stored narrative (seen live, 2026-09-15). Trusting
 * the flag alone put the model's scratch work on the page.
 *
 * So the flag is the ask and this is the check. A leaked block is dropped
 * rather than shown, and a response that is ONLY a thinking block yields ""
 * -- which the caller already treats as "no narrative", the same degraded
 * path as an unreachable model. That is the right outcome: no narrative beats
 * a narrative made of deliberation.
 */
export function stripReasoning(raw: string): string {
  let text = raw;
  // Closed blocks anywhere in the response.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // An unclosed opener (truncated output) -- everything after it is thinking.
  text = text.replace(/<think>[\s\S]*$/i, "");
  // A stray closer with its opener lost upstream: keep only what follows,
  // since the prose answer always comes after the reasoning.
  const lastClose = text.toLowerCase().lastIndexOf("</think>");
  if (lastClose !== -1) text = text.slice(lastClose + "</think>".length);
  return text.trim();
}

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
      timeoutMs: NARRATIVE_TIMEOUT_MS,
      think: false,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: narrativePrompt(debrief) },
      ],
    });
    const text = stripReasoning(result.content);
    if (!text) {
      log.info("narrative skipped: model returned no prose (empty, or reasoning only)");
      return null;
    }
    // The model ignored "two to four plain sentences" and produced a report.
    // Drop it: an advisory field is optional, and no narrative is honest
    // where a wall of markdown in a prose slot is not.
    if (text.length > NARRATIVE_MAX_CHARS) {
      log.info(`narrative skipped: ${text.length} chars exceeds ${NARRATIVE_MAX_CHARS}`);
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
