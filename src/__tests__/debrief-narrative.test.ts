import { describe, expect, it, vi } from "vitest";

// Mocked so these assertions test OUR contract enforcement, not qwen3's mood.
// The live model is what taught us the contract is needed (54s/104s calls,
// 5,681-char markdown reports); it is far too slow and variable to assert on.
const chat = vi.hoisted(() => vi.fn());
vi.mock("@barry-rocks/agent-runtime", () => ({
  ollamaChat: chat,
  ModelUnavailableError: class ModelUnavailableError extends Error {},
}));

const { stripReasoning, generateNarrative, NARRATIVE_MAX_CHARS } = await import(
  "../debrief-narrative.js"
);

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

describe("generateNarrative output contract", () => {
  it("stores a short reply", async () => {
    chat.mockResolvedValueOnce({ content: "Six sessions are active. None are flagged." });
    const result = await generateNarrative(DEBRIEF);
    expect(result?.text).toBe("Six sessions are active. None are flagged.");
    expect(result?.inputsHash).toBe("hash-1");
  });

  it("discards an over-long reply rather than truncating it", async () => {
    // The real failure: asked for 2-4 sentences, qwen3:4b returned 5,681
    // characters of markdown tables. Truncating would put a half-table in a
    // prose slot; the debrief is complete without any narrative at all.
    chat.mockResolvedValueOnce({ content: "#".repeat(NARRATIVE_MAX_CHARS + 1) });
    expect(await generateNarrative(DEBRIEF)).toBeNull();
  });

  it("keeps a reply exactly at the limit", async () => {
    const exact = "a".repeat(NARRATIVE_MAX_CHARS);
    chat.mockResolvedValueOnce({ content: exact });
    expect((await generateNarrative(DEBRIEF))?.text).toBe(exact);
  });

  it("measures the length AFTER stripping reasoning", async () => {
    // A long think block plus a short answer must survive: it is the prose
    // that has to fit, not the model's scratch work.
    const reasoning = "<think>" + "z".repeat(NARRATIVE_MAX_CHARS * 2) + "</think>";
    chat.mockResolvedValueOnce({ content: `${reasoning}Two sessions are idle.` });
    expect((await generateNarrative(DEBRIEF))?.text).toBe("Two sessions are idle.");
  });

  it("returns null when the model throws", async () => {
    chat.mockRejectedValueOnce(new Error("boom"));
    expect(await generateNarrative(DEBRIEF)).toBeNull();
  });
});
