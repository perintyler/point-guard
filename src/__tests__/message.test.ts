/**
 * POST /message's handler: the Heartbeat pattern -- assemble a fresh
 * snapshot, one model call, log the pair, no chaining. Network and
 * credential resolution are mocked; this tests the assembly/logging logic
 * point-guard owns.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PointGuardStore } from "../store.js";
import { tempStoreEnv } from "./fixture.js";

const h = vi.hoisted(() => ({
  credentials: { ok: true as const, apiKey: "test-key", source: "env" as const },
  fetchImpl: null as null | ((url: string, init: any) => Promise<Response>),
}));

vi.mock("../message-key.js", () => ({
  resolveMessageCredentials: vi.fn(async () => h.credentials),
}));

const { handleMessage } = await import("../message.js");

function mockFetchOnce(status: number, body: unknown): void {
  global.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  tempStoreEnv();
  h.credentials = { ok: true, apiKey: "test-key", source: "env" };
});

describe("handleMessage", () => {
  it("returns the model's reply and logs the pair", async () => {
    mockFetchOnce(200, { choices: [{ message: { content: "Nothing is stuck." } }] });
    const store = new PointGuardStore();

    const result = await handleMessage(store, "is anything stuck?");

    expect(result).toEqual({ ok: true, reply: "Nothing is stuck." });
    const log = store.recentMessageLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ message: "is anything stuck?", reply: "Nothing is stuck." });
  });

  it("fails cleanly, naming the reason, when credentials are unavailable", async () => {
    h.credentials = { ok: false, reason: "vault item missing" } as any;
    const store = new PointGuardStore();

    const result = await handleMessage(store, "hello");

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("vault item missing");
    expect(store.recentMessageLog()).toHaveLength(0);
  });

  it("fails cleanly and does not log when the model call itself errors", async () => {
    mockFetchOnce(429, { error: { message: "insufficient_quota" } });
    const store = new PointGuardStore();

    const result = await handleMessage(store, "hello");

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("429");
    expect(store.recentMessageLog()).toHaveLength(0);
  });

  it("fails cleanly when the model returns no content", async () => {
    mockFetchOnce(200, { choices: [{ message: {} }] });
    const store = new PointGuardStore();

    const result = await handleMessage(store, "hello");

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("no content");
  });

  it("includes book state in the prompt sent to the model", async () => {
    const store = new PointGuardStore();
    store.upsertBookRow({
      sessionId: "session-abc",
      repo: "/repo/.git",
      branch: "main",
      worktree: "/repo/wt",
      lastActivityAt: Date.now(),
      status: "conflicted",
      flaggedReason: "contended: a.ts",
    });

    let capturedBody: any = null;
    global.fetch = vi.fn(async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "ok" } }] }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await handleMessage(store, "what's going on?");

    const userMessage = capturedBody.messages.find((m: any) => m.role === "user").content;
    expect(userMessage).toContain("session-abc");
    expect(userMessage).toContain("contended: a.ts");
    expect(userMessage).toContain("what's going on?");
  });

  it("reports an empty book plainly rather than as an error", async () => {
    mockFetchOnce(200, { choices: [{ message: { content: "No sessions right now." } }] });
    const store = new PointGuardStore();

    let capturedBody: any = null;
    global.fetch = vi.fn(async (_url: string, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "No sessions right now." } }] }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await handleMessage(store, "status?");

    expect(result).toEqual({ ok: true, reply: "No sessions right now." });
    const userMessage = capturedBody.messages.find((m: any) => m.role === "user").content;
    expect(userMessage).toContain("no sessions currently in the book");
  });
});
