/**
 * Local-model compaction for point-guard's evidence (diffs/reports). Frequent,
 * cheap, strictly additive — Ollama unavailable degrades to log-and-skip,
 * never a failure, per bags/sessions/bag.yaml's contract for this exact
 * dependency ("a missing binary is a no-op, not a failure").
 *
 * Targets one measured cost driver: evidence re-sent across every remaining
 * tool iteration of a delegation's own retry/verify passes. There is no
 * standing conversation to compact anymore — point-guard answers each
 * message fresh from a book snapshot (Heartbeat pattern), so a chat-window
 * compaction pass has nothing to do.
 *
 * Compaction NEVER touches durable storage. It only shapes what gets SENT to
 * a caller this turn; the original evidence in SQLite is untouched —
 * compaction is a read-time lens, not a write.
 */
import { ollamaChat as chat, ModelUnavailableError } from "@barry-rocks/agent-runtime";
import { createLogger } from "@barry-rocks/logger";

const log = createLogger("point-guard:compaction");

/** Same choice as bags/sessions' bookkeeping job, for the same reasons: free,
 * fast enough (~0.4s warm), small enough to not compete with the actual work
 * for RAM, and Ollama evicts it between calls so idle cost is zero. */
export const DEFAULT_MODEL = "qwen3:4b";
export const DEFAULT_KEEP_ALIVE = "60s";

/** Below this, raw text is already cheap enough that a model round-trip
 * (network + inference latency) costs more than it saves. Chosen well under
 * the 40,000-char truncation cap in verifier.ts/loop.ts, so compaction fires
 * far more often than truncation does — "compress very often," not just
 * "compress when it would otherwise be cut off." */
export const COMPACTION_THRESHOLD_CHARS = 4_000;

const EVIDENCE_SYSTEM_PROMPT = `You compact evidence for a coding supervisor who never reads raw diffs or full reports — only your summary. Be concrete and complete about WHAT changed; never editorialize or guess intent beyond what the text shows.

Reply with ONLY a JSON object: {"summary": string, "filesTouched": string[], "keyFindings": string[]}
- summary: 2-4 sentences, what changed and why it matters for acceptance.
- filesTouched: paths you can identify from the text.
- keyFindings: notable risks, blockers, or judge findings — empty array if none.`;

export interface CompactedEvidence {
  summary: string;
  filesTouched: string[];
  keyFindings: string[];
}

/**
 * Compact a diff or report body if it's worth the round-trip. Returns null
 * (never throws) when Ollama is unavailable or the model output doesn't
 * parse — the caller's existing truncated-raw fallback is always safe to use
 * in that case, so a compaction failure is never a NEW failure mode for
 * evidence access.
 */
export async function compactEvidence(
  kind: "diff" | "report",
  text: string,
  options?: { model?: string; baseUrl?: string },
): Promise<CompactedEvidence | null> {
  if (text.length < COMPACTION_THRESHOLD_CHARS) return null; // not worth it
  try {
    const result = await chat({
      baseUrl: options?.baseUrl,
      model: options?.model ?? DEFAULT_MODEL,
      keepAlive: DEFAULT_KEEP_ALIVE,
      think: false,
      format: "json",
      messages: [
        { role: "system", content: EVIDENCE_SYSTEM_PROMPT },
        { role: "user", content: `Compact this ${kind} (${text.length} chars):\n\n${text.slice(0, 60_000)}` },
      ],
    });
    const parsed = JSON.parse(result.content) as Partial<CompactedEvidence>;
    if (typeof parsed.summary !== "string") return null;
    return {
      summary: parsed.summary,
      filesTouched: Array.isArray(parsed.filesTouched) ? parsed.filesTouched.filter((f) => typeof f === "string") : [],
      keyFindings: Array.isArray(parsed.keyFindings) ? parsed.keyFindings.filter((f) => typeof f === "string") : [],
    };
  } catch (error) {
    if (error instanceof ModelUnavailableError) {
      log.info(`evidence compaction skipped: ${error.message}`);
    } else {
      log.warn(`evidence compaction failed: ${String(error)}`);
    }
    return null;
  }
}

