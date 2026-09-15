/**
 * Routes tested against a STUB upstream point-guard rather than a live one.
 *
 * The stub is what lets the failure cases be tested at all: point-guard
 * unreachable and the secret is wrong are the states this proxy exists to
 * report honestly, and neither is reachable against a healthy local
 * point-guard.
 */
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let base: string;
let upstream: Server;
let upstreamCalls: Array<{ path: string; method: string; auth: string | undefined; body: string }>;
/** Flipped per test to drive the upstream behaviour. */
let upstreamMode: "ok" | "forbidden" | "message-unavailable" = "ok";

// The server reads these at import time, so they must be set before it loads.
process.env.VITEST = "1";
process.env.BARRY_SECRET = "test-secret";

beforeAll(async () => {
  upstreamCalls = [];
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      upstreamCalls.push({
        path: req.url ?? "",
        method: req.method ?? "",
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (upstreamMode === "forbidden") return send(403, { error: "forbidden" });
      if (req.url === "/book") {
        return send(200, {
          sessions: [
            {
              sessionId: "sess_abcdef123456",
              repo: "/Users/tyler/repos/barry",
              branch: "main",
              worktree: "/Users/tyler/repos/barry",
              lastActivityAt: 1700000000000,
              status: "ok",
              flaggedReason: null,
              mergeTreeCheckedAt: null,
              updatedAt: 1700000000000,
            },
          ],
        });
      }
      if (req.url === "/message" && req.method === "POST") {
        // Mirrors point-guard's own validation (src/message.ts route): a
        // missing/non-string content 400s before any model call is made.
        let parsed: { content?: unknown } = {};
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          // fall through with empty parsed -- treated as missing content
        }
        if (!parsed.content || typeof parsed.content !== "string") {
          return send(400, { error: "content required" });
        }
        if (upstreamMode === "message-unavailable") {
          return send(503, { error: "messaging offline: no credentials" });
        }
        return send(200, { reply: "all sessions look fine" });
      }
      if (req.url?.startsWith("/message/history")) {
        return send(200, { messages: [{ id: "m1", message: "status?", reply: "all fine", createdAt: 1700000000000 }] });
      }
      // Answered 200 on purpose: these are routes the proxy must NOT forward.
      if (req.url?.startsWith("/delegations") || req.url?.startsWith("/plans") || req.url?.startsWith("/admin")) {
        return send(200, { leaked: "this route must never be proxied" });
      }
      return send(404, { error: "not found" });
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  process.env.BARRY_POINT_GUARD_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const { server } = await import("./index.js");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  const { server } = await import("./index.js");
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
});

async function call(path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("point-guard web service", () => {
  it("serves the app shell and its assets", async () => {
    for (const [path, type] of [["/", "text/html"], ["/app.css", "text/css"], ["/app.js", "text/javascript"]]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toContain(type);
    }
  });

  it("reports healthy only when point-guard actually answers GET /book", async () => {
    upstreamMode = "ok";
    const { status, body } = await call("/health");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  /**
   * The negative control for the health check. Without it, healthy and
   * every call 403s would render identically -- the check that cannot fail.
   */
  it("reports UNhealthy when point-guard rejects the secret", async () => {
    upstreamMode = "forbidden";
    const { status, body } = await call("/health");
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("403");
    upstreamMode = "ok";
  });

  it("proxies GET /api/book with the upstream status and body", async () => {
    const before = upstreamCalls.length;
    const { status, body } = await call("/api/book");
    expect(status).toBe(200);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].sessionId).toBe("sess_abcdef123456");
    expect(upstreamCalls[before].path).toBe("/book");
    expect(upstreamCalls[before].auth).toBe("Bearer test-secret");
  });

  it("forwards POST /api/message body and returns the reply", async () => {
    const before = upstreamCalls.length;
    const { status, body } = await call("/api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "what is scout doing?" }),
    });
    expect(status).toBe(200);
    expect(body.reply).toBe("all sessions look fine");
    expect(upstreamCalls[before].path).toBe("/message");
    expect(upstreamCalls[before].method).toBe("POST");
    expect(JSON.parse(upstreamCalls[before].body).content).toBe("what is scout doing?");
    expect(upstreamCalls[before].auth).toBe("Bearer test-secret");
  });

  /**
   * The error case matters as much as the happy path: a UI that cannot tell
   * messaging offline from a real reply would show a fabricated answer.
   */
  it("passes an upstream POST /message failure through with its status", async () => {
    upstreamMode = "message-unavailable";
    const { status, body } = await call("/api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "status?" }),
    });
    expect(status).toBe(503);
    expect(body.error).toContain("messaging offline");
    upstreamMode = "ok";
  });

  it("passes point-guard's 400 through unchanged for a message with no content", async () => {
    // The proxy does not itself validate the body -- point-guard is the
    // authority on what a valid message is, so this must reach upstream and
    // come back as point-guard's own 400, not a proxy-invented one.
    const before = upstreamCalls.length;
    const { status, body } = await call("/api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(status).toBe(400);
    expect(body.error).toContain("content");
    expect(upstreamCalls[before].path).toBe("/message");
  });

  it("forwards the limit query param on GET /api/message/history", async () => {
    const before = upstreamCalls.length;
    const { status, body } = await call("/api/message/history?limit=5");
    expect(status).toBe(200);
    expect(body.messages).toHaveLength(1);
    expect(upstreamCalls[before].path).toBe("/message/history?limit=5");
  });

  it("proxies only the three endpoints the UI needs", async () => {
    const before = upstreamCalls.length;
    for (const path of ["/api/delegations", "/api/plans", "/api/admin/resync"]) {
      const { status, body } = await call(path);
      expect(status, path).toBe(404);
      expect(JSON.stringify(body), path).not.toContain("leaked");
    }
    expect(upstreamCalls.slice(before)).toHaveLength(0);
  });

  it("refuses to serve files outside the asset allowlist", async () => {
    for (const path of ["/../../../etc/passwd", "/../web-server/src/index.ts", "/../bag.yaml", "/index.html"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it("never lets the secret ride back out to the browser", async () => {
    const { body } = await call("/api/book");
    expect(JSON.stringify(body)).not.toContain("test-secret");
  });
});
