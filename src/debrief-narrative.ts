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
import { resolveMessageCredentials } from "./message-key.js";
import type { Debrief, DebriefNarrative } from "./debrief.js";

const log = createLogger("point-guard:debrief-narrative");

/** The local fallback model. */
export const NARRATIVE_MODEL = "qwen3:4b";

/** The primary. Same model and credential POST /message already uses. */
export const NARRATIVE_HOSTED_MODEL = "gpt-5.4-mini";

/**
 * How often the narrative tick runs. Lives here, next to the keep-alive it
 * constrains, rather than in the server -- the two are one decision and were
 * previously separated by a module boundary, which is how they came to
 * contradict each other. `assertKeepAliveOutlivesInterval` below is the
 * mechanism; this adjacency is the reminder.
 */
export const NARRATIVE_INTERVAL_MS = 300_000;

/**
 * How long Ollama keeps the model resident after a call.
 *
 * MUST outlive NARRATIVE_INTERVAL_MS. This was "60s" against a 300s tick,
 * which meant Ollama evicted the model four minutes before every single
 * call, so each one paid a cold start -- and the narrative NEVER generated
 * once in production (0 rows, nothing but timeouts in the log) from the day
 * it shipped.
 *
 * Measured against the live daemon with the real 2,756-char prompt:
 *
 *   cold start (what production did every tick):  150s, TIMED OUT
 *   warm model, same prompt:                       69.7s, succeeded
 *
 * A keep-alive shorter than the interval that drives it can only ever be
 * self-defeating: the model is guaranteed to be gone when the next call
 * arrives. The margin here is deliberate -- the tick is not a precise clock,
 * and a keep-alive merely EQUAL to the interval would race it.
 */
export const NARRATIVE_KEEP_ALIVE = "10m";

/** Parse Ollama's keep-alive spelling ("60s", "10m", "1h") to milliseconds. */
export function keepAliveMs(spec: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(spec.trim());
  if (!match) throw new Error(`unparseable keep-alive: ${spec}`);
  const value = Number(match[1]);
  switch (match[2]) {
    case "ms": return value;
    case "s": return value * 1000;
    case "m": return value * 60_000;
    default: return value * 3_600_000;
  }
}

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
 * Hard ceiling on tokens generated.
 *
 * The prompt asks for two to four sentences and the model has repeatedly
 * ignored it -- once with 5,681 characters of markdown tables, routinely
 * with a long `<think>` preamble that `think: false` does not suppress.
 * A prompt is a request; this is the constraint.
 *
 * The number comes from measurement, not taste. qwen3:4b on this machine
 * runs ~30 tokens/sec under load, and a real answer measured 222-339
 * tokens. So 400 leaves comfortable room for the answer while capping the
 * worst case near 13s -- well inside NARRATIVE_TIMEOUT_MS, where an
 * unbounded run at 2,700+ tokens would exceed it. Bounding generation is
 * what makes the timeout a backstop rather than the primary failure mode.
 */
export const NARRATIVE_NUM_PREDICT = 400;

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
      // Summaries only for sessions that are NOT ok, and short even then.
      // These were 160 chars for every session and made up most of a
      // 2,756-char prompt, which is what pushed the call past its budget on
      // a loaded host. The prose is about the TEAM; a healthy session's
      // summary is already rendered per-row by every client, so spending
      // prompt on it here buys nothing and costs generation time.
      const doing =
        s.status !== "ok" && s.latestSummary
          ? ` — ${s.latestSummary.replace(/\s+/g, " ").slice(0, 80)}`
          : "";
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

/**
 * The local path. Kept as a FALLBACK, not the primary -- see
 * generateNarrative below for why it lost that job.
 */
export async function generateNarrativeLocally(
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
      numPredict: NARRATIVE_NUM_PREDICT,
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

/**
 * The hosted path, and the primary one.
 *
 * `qwen3:4b` had this job first and never did it once in production. Two
 * independent reasons, both measured rather than assumed:
 *
 *   1. It deliberates in UNMARKED prose -- "Hmm, the user wants me to...",
 *      "Let's structure:" -- so `stripReasoning` cannot remove it (there is
 *      no `<think>` tag to find) and the deliberation reaches the page as
 *      if it were the summary. A terse system prompt did not stop it; the
 *      behaviour is the model's, not the prompt's.
 *   2. At ~30 tok/s under load it spends its whole token budget
 *      deliberating and is cut off BEFORE writing the answer.
 *
 * gpt-5.4-mini, same prompt, same snapshot: 2.9s, 657 characters, clean
 * prose, and it correctly wrote "troubles not flagged because none were
 * recorded" rather than an overclaim. That is the whole job.
 *
 * On cost: this is the same credential and model POST /message already
 * uses. The call is bounded by `shouldRegenerate` -- an unchanged
 * `inputsHash` regenerates nothing -- so an idle team costs nothing at all,
 * and a busy one costs one small call per five minutes at most.
 *
 * Falls back to the local model when no credential resolves, so an offline
 * machine degrades to "sometimes a narrative" rather than an error. Both
 * paths may return null, and a null narrative is a supported state in every
 * client.
 */
export async function generateNarrative(
  debrief: Debrief,
  options?: { model?: string; baseUrl?: string },
): Promise<DebriefNarrative | null> {
  // An explicit model/baseUrl override means a caller (or a test) is asking
  // for the local path by name; honour it rather than reaching for a key.
  if (options?.model || options?.baseUrl) return generateNarrativeLocally(debrief, options);

  let apiKey: string | undefined;
  try {
    const credentials = await resolveMessageCredentials();
    if ("apiKey" in credentials && credentials.apiKey) apiKey = credentials.apiKey;
  } catch (error) {
    log.info(`narrative: no hosted credential (${String(error)}); trying the local model`);
  }
  if (!apiKey) return generateNarrativeLocally(debrief, options);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: NARRATIVE_HOSTED_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: narrativePrompt(debrief) },
        ],
      }),
      signal: AbortSignal.timeout(NARRATIVE_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      log.warn(`narrative: hosted call failed (${response.status}): ${body.slice(0, 200)}`);
      return generateNarrativeLocally(debrief, options);
    }
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const text = stripReasoning(body?.choices?.[0]?.message?.content ?? "");
    if (!text) {
      log.info("narrative skipped: hosted model returned no prose");
      return null;
    }
    if (text.length > NARRATIVE_MAX_CHARS) {
      log.info(`narrative skipped: ${text.length} chars exceeds ${NARRATIVE_MAX_CHARS}`);
      return null;
    }
    return { text, model: NARRATIVE_HOSTED_MODEL, generatedAt: Date.now(), inputsHash: debrief.inputsHash };
  } catch (error) {
    log.warn(`narrative: hosted call errored (${String(error)}); trying the local model`);
    return generateNarrativeLocally(debrief, options);
  }
}
