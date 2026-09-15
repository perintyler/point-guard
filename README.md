# point-guard

Barry's team supervisor. Watches active sessions (interactive claude/codex/etc
sessions and its own delegation workers), keeps a live "book" of their state,
and lets you message it for a status check.

```bash
curl -H "authorization: Bearer $BARRY_SECRET" http://127.0.0.1:3868/book
curl -X POST -H "authorization: Bearer $BARRY_SECRET" -H "content-type: application/json" \
  -d '{"content":"is anything stuck?"}' http://127.0.0.1:3868/message
```

## What is worth knowing before changing anything here

**The book is a read-model, not a log.** `GET /book` returns whatever the last
supervisor tick (every 60s) computed from real sources — `sessions`/`messages`
via `@barry-rocks/db`, `locks.db` via `@barry-rocks/locks-bag`, `file-tracker.db`
via `@barry-rocks/file-tracker`. Delete the `book` table and the next tick
rebuilds it byte-for-byte. Nothing here reads either `.db` file directly — both
already expose query functions through their owning packages, and a live
incident elsewhere in this project is why that rule is not optional.

**`mergeTreeCheckedAt: null` and a real timestamp mean different things.**
`null` means the slower conflict backstop (`git merge-tree`, every 5 minutes)
has never run for that session. A timestamp — even with `status: "ok"` — means
it ran and found nothing. Collapsing those into one "all clear" state in a
client is the exact bug this field exists to let you avoid.

**A conflict verdict says "no textual conflict", never "safe".**
`git merge-tree` proves the absence of a textual clash, not semantic
compatibility — two sessions editing disjoint files can still combine to break
something that passes in isolation. Don't upgrade the wording in a client.

**`POST /message` never remembers the last message.** Every call is answered
fresh from a book snapshot (the Heartbeat pattern) — there is no standing
conversation, no `previous_response_id` chaining. `messages_log` is a
display-only scrollback for the human, never replayed as context.

**There is no brain anymore.** An earlier version of this bag ran a standing
OpenAI-backed chat loop (`src/brain/`) that decided things on its own. It is
gone — point-guard now only executes plans handed to it and answers status
questions; it does not plan or decide.

## Layout

| Path | What it is |
|---|---|
| `src/store.ts` | SQLite schema and all state transitions (`~/.barry/point-guard.db`) |
| `src/supervisor.ts` | The 60s tick: book verdicts, real-time conflict tier, stuck detection |
| `src/merge-tree-backstop.ts` | The 5-minute tick: `git merge-tree` pairwise simulation |
| `src/stuck-detection.ts` | Result-aware repeated tool-call hashing, pure function |
| `src/message.ts` / `message-key.ts` | `POST /message`'s model call and vault-resolved credential |
| `src/scheduler.ts` / `merge.ts` / `worker.ts` / `verifier.ts` | The delegation/plan execution pipeline |
| `server/src/index.ts` | The main HTTP+WS service on port 3868 |
| `web-server/` + `web/` | Thin authenticated proxy + browser UI at point.barry.rocks |
| `point-guard-macos/app/` | Native macOS client (SwiftPM, `BarryKit`) |
| `tui/` | Rust terminal client — a pure client of this service, nothing more |
| `tools.ts` | MCP surface: `delegate_task`, `submit_plan`, `check_plan`, and read-only status tools |

The iOS client lives outside this repo entirely, at
`~/repos/bags/point-guard-ios` — an app has no bag-installable bundle
(`packages/bags/src/manifest.ts`'s `apps:` schema is `platform: "macos"`
only), so it was never a candidate for `bag.yaml`.

## Tests

**`vitest.config.ts` is load-bearing for more than timeouts.** It inlines
`testDatabaseEnv()` from `@barry-rocks/db/test-db-url`, which pins the test
database so no suite can reach production. `getDatabaseUrl()` short-circuits
on `BARRY_DATABASE_URL` before it reads `BARRY_DATABASE_NAME`, and dev shells
export the production URL -- so removing that import does not fail, it
quietly points the whole suite at prod. It was nearly lost during extraction
(it used to arrive from the monorepo's vitest.base.config.ts) and is the one
config here whose absence would be silent and destructive.

```bash
pnpm test   # vitest, the TypeScript surface
swift test  # from point-guard-macos/app, the macOS client
cargo test  # from tui, the terminal client
```

A suite that has never failed is a claim, not evidence — the tests that matter
most here (`evaluateStuck`'s result-aware hashing, `checkMergeTree`'s exit-code
handling) were each verified against a deliberate break before being trusted.
