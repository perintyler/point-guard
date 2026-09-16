import { describe, expect, it, vi } from "vitest";

// Mocked so these assertions test OUR contract enforcement, not qwen3's mood.
// The live model is what taught us the contract is needed (54s/104s calls,
// 5,681-char markdown reports); it is far too slow and variable to assert on.
const chat = vi.hoisted(() => vi.fn());
vi.mock("@barry-rocks/agent-runtime", () => ({
  ollamaChat: chat,
  ModelUnavailableError: class ModelUnavailableError extends Error {},
}));

const {
  stripReasoning,
  generateNarrative,
  generateNarrativeLocally,
  NARRATIVE_MAX_CHARS,
  NARRATIVE_KEEP_ALIVE,
  NARRATIVE_INTERVAL_MS,
  keepAliveMs,
} = await import("../debrief-narrative.js");

const DEBRIEF = { inputsHash: "hash-1", counts: {}, sessions: [], plans: [], trouble: [] } as never;

/**
 * These cases are not hypothetical. `think: false` was already set when
 * qwen3:4b returned the monologue in `leakedLive` below, and every character
 * of it was stored as the narrative and served to clients. The flag asks; it
 * does not guarantee. These tests pin the check that catches it anyway.
 */
describe("stripReasoning", () => {
  const prose =
    "There are 11 sessions total: 6 active in the last 10 minutes, 5 quiet, 0 stuck, and 0 conflicted.";

  it("leaves a clean response untouched", () => {
    expect(stripReasoning(prose)).toBe(prose);
  });

  it("drops a closed thinking block and keeps the prose", () => {
    expect(stripReasoning(`<think>Let me count the sessions. 11 total.</think>\n\n${prose}`)).toBe(prose);
  });

  it("handles the real leak captured from a live run", () => {
    // Trimmed from the actual response: qwen3 closes with `</think>` and then
    // repeats its answer. The opener was absent from the captured stream,
    // which is exactly why the `</think>`-only branch exists.
    const leakedLive = [
      'Also, the session "yYj0_LFR" is the only one without a summary? Yes.',
      "",
      "We'll go with that.",
      "",
      "Final answer:",
      "",
      prose,
      "</think>",
      "",
      prose,
    ].join("\n");
    expect(stripReasoning(leakedLive)).toBe(prose);
  });

  it("drops an unclosed thinking block rather than showing scratch work", () => {
    // A truncated response: the model never stopped reasoning. Showing the
    // fragment would be worse than showing nothing.
    expect(stripReasoning("<think>I should start by counting the sess")).toBe("");
  });

  it("returns empty when the response is reasoning only", () => {
    // "" is the caller's degraded path -- no narrative, same as an
    // unreachable model. Deliberate: no narrative beats deliberation.
    expect(stripReasoning("<think>Hmm, let me think about this.</think>")).toBe("");
  });

  it("is case-insensitive about the tag", () => {
    expect(stripReasoning(`<THINK>reasoning</THINK>${prose}`)).toBe(prose);
  });

  it("strips multiple blocks", () => {
    expect(stripReasoning(`<think>one</think>${prose}<think>two</think>`)).toBe(prose);
  });
});

describe("generateNarrativeLocally output contract", () => {
  it("stores a short reply", async () => {
    chat.mockResolvedValueOnce({ content: "Six sessions are active. None are flagged." });
    const result = await generateNarrativeLocally(DEBRIEF);
    expect(result?.text).toBe("Six sessions are active. None are flagged.");
    expect(result?.inputsHash).toBe("hash-1");
  });

  it("discards an over-long reply rather than truncating it", async () => {
    // The real failure: asked for 2-4 sentences, qwen3:4b returned 5,681
    // characters of markdown tables. Truncating would put a half-table in a
    // prose slot; the debrief is complete without any narrative at all.
    chat.mockResolvedValueOnce({ content: "#".repeat(NARRATIVE_MAX_CHARS + 1) });
    expect(await generateNarrativeLocally(DEBRIEF)).toBeNull();
  });

  it("keeps a reply exactly at the limit", async () => {
    const exact = "a".repeat(NARRATIVE_MAX_CHARS);
    chat.mockResolvedValueOnce({ content: exact });
    expect((await generateNarrativeLocally(DEBRIEF))?.text).toBe(exact);
  });

  it("measures the length AFTER stripping reasoning", async () => {
    // A long think block plus a short answer must survive: it is the prose
    // that has to fit, not the model's scratch work.
    const reasoning = "<think>" + "z".repeat(NARRATIVE_MAX_CHARS * 2) + "</think>";
    chat.mockResolvedValueOnce({ content: `${reasoning}Two sessions are idle.` });
    expect((await generateNarrativeLocally(DEBRIEF))?.text).toBe("Two sessions are idle.");
  });

  it("returns null when the model throws", async () => {
    chat.mockRejectedValueOnce(new Error("boom"));
    expect(await generateNarrativeLocally(DEBRIEF)).toBeNull();
  });
});

describe("keep-alive outlives the tick that drives it", () => {
  /**
   * The narrative did not generate ONCE in production between shipping and
   * 2026-09-15 -- `debrief_narrative` held 0 rows and the log held nothing
   * but timeouts. The cause was not the model, the prompt, or the host:
   * NARRATIVE_KEEP_ALIVE was "60s" while the tick driving it ran every 300s,
   * so Ollama evicted the model four minutes before every single call and
   * each one paid a cold start.
   *
   * Measured with the real prompt: cold = 150s (timed out), warm = 69.7s.
   *
   * These assert the RELATIONSHIP, not the values, so the two constants can
   * be retuned freely but never moved back into contradiction.
   */
  it("keeps the model resident longer than the gap between calls", () => {
    expect(keepAliveMs(NARRATIVE_KEEP_ALIVE)).toBeGreaterThan(NARRATIVE_INTERVAL_MS);
  });

  it("leaves real margin, since the tick is not a precise clock", () => {
    // Merely EQUAL would race the timer -- eviction and the next call would
    // land together and the winner would vary.
    expect(keepAliveMs(NARRATIVE_KEEP_ALIVE)).toBeGreaterThanOrEqual(NARRATIVE_INTERVAL_MS * 1.5);
  });

  it("parses every keep-alive unit Ollama accepts", () => {
    expect(keepAliveMs("500ms")).toBe(500);
    expect(keepAliveMs("60s")).toBe(60_000);
    expect(keepAliveMs("10m")).toBe(600_000);
    expect(keepAliveMs("1h")).toBe(3_600_000);
  });

  it("refuses a spelling it cannot parse rather than guessing a number", () => {
    // A silent 0 here would make the comparison above pass while meaning
    // nothing -- the exact shape of failure this suite exists to prevent.
    expect(() => keepAliveMs("forever")).toThrow(/unparseable/);
    expect(() => keepAliveMs("")).toThrow(/unparseable/);
  });
});

describe("narrative model routing", () => {
  /**
   * The local model had this job first and never did it once in production.
   * It deliberates in UNMARKED prose ("Hmm, the user wants me to..."), so
   * stripReasoning cannot remove it -- there is no <think> tag to find --
   * and at ~30 tok/s it is cut off before reaching the answer. The hosted
   * model does the same job in ~2s.
   *
   * So the hosted path is primary. These pin the routing, because a silent
   * fall back to the local model would look exactly like success until
   * someone read the narrative and found deliberation in it.
   */
  it("uses the local model when a caller names one explicitly", async () => {
    // An explicit model/baseUrl is a caller asking for local BY NAME -- a
    // test, or an offline deployment. It must not reach for a credential.
    chat.mockResolvedValueOnce({ content: "Four sessions are quiet." });
    const result = await generateNarrative(DEBRIEF, { model: "qwen3:4b" });
    expect(result?.model).toBe("qwen3:4b");
    expect(chat).toHaveBeenCalled();
  });

  it("falls back to the local model when no hosted credential resolves", async () => {
    // resolveMessageCredentials is unmocked here and finds no key in the
    // test env, which is the offline case: degrade, never throw.
    chat.mockResolvedValueOnce({ content: "Two sessions are active." });
    const result = await generateNarrative(DEBRIEF);
    expect(result?.text).toBe("Two sessions are active.");
    expect(result?.model).toBe("qwen3:4b");
  });

  it("returns null rather than throwing when both paths fail", async () => {
    chat.mockRejectedValueOnce(new Error("ollama down"));
    expect(await generateNarrative(DEBRIEF)).toBeNull();
  });
});
