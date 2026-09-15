/**
 * Compaction degrades to log-and-skip when Ollama is unavailable, per the
 * sessions-bag doctrine this bag's dependency declaration borrows: "a
 * missing binary is a no-op, not a failure." These tests point at a port
 * nothing listens on, so they exercise the real degrade path without
 * requiring Ollama to be installed in CI.
 */
import { describe, expect, it } from "vitest";
import { compactEvidence, COMPACTION_THRESHOLD_CHARS } from "../compaction.js";

const UNREACHABLE = "http://127.0.0.1:1"; // reserved port; nothing binds here

describe("compaction degrades safely when Ollama is unavailable", () => {
  it("compactEvidence returns null, never throws, when the daemon is unreachable", async () => {
    const longText = "x".repeat(COMPACTION_THRESHOLD_CHARS + 1);
    const result = await compactEvidence("diff", longText, { baseUrl: UNREACHABLE });
    expect(result).toBeNull();
  });

  it("compactEvidence skips the round-trip entirely below the threshold — no network call attempted", async () => {
    const shortText = "short diff";
    // If this attempted a call it would still return null against
    // UNREACHABLE, so the meaningful assertion is timing: a below-threshold
    // call must resolve near-instantly, not after Ollama's connect timeout.
    const start = Date.now();
    const result = await compactEvidence("diff", shortText, { baseUrl: UNREACHABLE });
    expect(result).toBeNull();
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe("compaction with a real local Ollama, if available (self-skipping)", () => {
  // Real inference under a loaded test run (many files' worth of git/worktree
  // work competing for CPU) can cold-load the model well past the file's
  // already-generous 30s default — same reasoning as vitest.config.ts's
  // comment on the git-heavy tests: give this one real headroom rather than
  // let it read as flake whenever the machine is busy.
  it("compacts a long diff into a structured summary when the model is reachable", { timeout: 60_000 }, async () => {
    const probe = await compactEvidence("diff", "x".repeat(10), {}).catch(() => null);
    void probe; // just a reachability nudge; real assertion below is conditional
    const { ollamaIsModelAvailable, ollamaBaseUrl } = await import("@barry-rocks/agent-runtime");
    const available = await ollamaIsModelAvailable("qwen3:4b", ollamaBaseUrl()).catch(() => false);
    if (!available) {
      console.warn("[compaction.test] qwen3:4b not available locally — skipping live compaction assertion");
      return;
    }
    const longDiff = `diff --git a/counter.js b/counter.js\n${"+".repeat(50)}\n`.repeat(200);
    const result = await compactEvidence("diff", longDiff);
    expect(result).not.toBeNull();
    expect(typeof result?.summary).toBe("string");
    expect(result?.summary.length).toBeGreaterThan(0);
  });
});
