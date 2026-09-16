/**
 * point-guard web app — glance at the book and message point-guard from a
 * browser or a phone.
 *
 * Plain node:http with no framework and no build step: the memory/plans/
 * actions shape. This server is a THIN AUTHENTICATED PROXY, and that is its
 * whole reason to exist. point-guard requires BARRY_SECRET; a browser must
 * never hold it, so the token is attached here and only the endpoints the UI
 * needs are re-exposed. Nothing else is proxied -- a generic pass-through
 * would hand the open internet every route on point-guard (delegation
 * dispatch, plan intake, merge confirmation), which is the opposite of what
 * a gated origin is for.
 *
 * Binds loopback only. Caddy serves https://point.barry.lan via `host:` in
 * bag.yaml, and the shared cloudflared tunnel publishes point.barry.rocks --
 * gated by the "Barry Point Guard" Cloudflare Access application, because
 * this origin has no auth of its own.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, "..", "..", "web");
const PORT = Number(process.env.PORT || 4895);

/**
 * Where point-guard lives. Read from the environment so a dev instance can
 * point at a dev point-guard, but defaulted to the prod port this service is
 * installed alongside.
 */
const API_BASE = process.env.BARRY_POINT_GUARD_URL ?? "http://127.0.0.1:3868";
const SECRET = process.env.BARRY_SECRET ?? "";

/**
 * Files servable from web/, by explicit allowlist rather than a path join --
 * `join(WEB_DIR, url.pathname)` is a directory traversal, and "binds loopback
 * today" is not a security boundary when a tunnel publishes the same port.
 */
const STATIC_ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
};

function json(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      // A chat message is a few sentences, not a megabyte -- refuse early
      // rather than buffering something that was never a real message.
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Call point-guard with the service secret attached.
 *
 * Returns the upstream status alongside the body so a 404 (or 401/403/503)
 * from point-guard stays exactly that here. Collapsing upstream failures
 * into 200 or 500 is exactly the check that cannot fail: a UI that renders
 * the same thing for "no sessions" and "point-guard is down" is worse than
 * one that says point-guard is down.
 */
async function callApi(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${SECRET}`,
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // point-guard answers HTML on an unmatched route. Surfacing that raw
    // would put a page of markup where the UI expects a message.
    body = { error: "upstream_not_json", message: text.slice(0, 200) };
  }
  return { status: res.status, body };
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const method = req.method ?? "GET";

  try {
    /**
     * Health reports whether SECRET is configured and point-guard actually
     * answers GET /book, rather than just that this process is up. A probe
     * that returns ok while every call 403s would be indistinguishable from
     * a healthy one.
     */
    if (url.pathname === "/health") {
      if (!SECRET) {
        return json(res, { ok: false, error: "BARRY_SECRET is not set" }, 503);
      }
      try {
        const probe = await callApi("/book");
        return probe.status === 200
          ? json(res, { ok: true, api: API_BASE })
          : json(res, { ok: false, error: `api returned ${probe.status}` }, 503);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json(res, { ok: false, error: `api unreachable: ${message}` }, 503);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      if (!SECRET) {
        return json(res, { error: "BARRY_SECRET is not set on the point-guard web service" }, 503);
      }

      if (url.pathname === "/api/book" && method === "GET") {
        const { status, body } = await callApi("/book");
        return json(res, body, status);
      }

      // The upstream status is passed through deliberately: /debrief answers
      // 503 until the first tick has produced one, and a browser that showed
      // "no sessions" for "the supervisor has not started yet" would be
      // exactly the collapse this proxy exists to avoid.
      if (url.pathname === "/api/debrief" && method === "GET") {
        const { status, body } = await callApi("/debrief");
        return json(res, body, status);
      }

      if (url.pathname === "/api/message" && method === "POST") {
        const body = await readBody(req);
        const { status, body: upstreamBody } = await callApi("/message", { method: "POST", body });
        return json(res, upstreamBody, status);
      }

      if (url.pathname === "/api/message/history" && method === "GET") {
        const limit = url.searchParams.get("limit") ?? "50";
        const { status, body } = await callApi(`/message/history?limit=${encodeURIComponent(limit)}`);
        return json(res, body, status);
      }

      return json(res, { error: "not found" }, 404);
    }

    const asset = STATIC_ASSETS[url.pathname];
    if (asset && method === "GET") {
      const content = readFileSync(join(WEB_DIR, asset.file));
      res.writeHead(200, {
        "content-type": asset.type,
        "content-length": content.length,
        "cache-control": "no-store",
      });
      return res.end(content);
    }

    return json(res, { error: "not found" }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(res, { error: message }, message === "invalid JSON body" ? 400 : 500);
  }
});

// Under vitest the module is imported for its exports; the listener would
// hold the process open and fight parallel test files over the port.
if (!process.env.VITEST) {
  server.listen(PORT, "127.0.0.1", () => {
    process.stdout.write(`point-guard web listening on http://127.0.0.1:${PORT} (api: ${API_BASE})\n`);
  });
}
