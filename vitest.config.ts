import { defineConfig } from "vitest/config";
import { testDatabaseEnv } from "@barry-rocks/db/test-db-url";

/**
 * Standalone config. Inside the monorepo this merged barry's
 * vitest.base.config.ts; extracted, that relative path no longer resolves, so
 * the base's two real contributions are inlined here rather than lost:
 * silent logs, and -- the one that matters -- testDatabaseEnv(), which pins
 * the test database so no suite can reach production by accident.
 * getDatabaseUrl() short-circuits on BARRY_DATABASE_URL before it ever reads
 * BARRY_DATABASE_NAME, and dev shells export the production URL, so pinning
 * only the name would not be enough.
 *
 * point-guard's tests drive the real machinery rather than mocking it: each
 * one creates a git fixture repo, spawns detached worktrees, runs acceptance
 * checks in them and publishes through the merge queue. Several land between
 * 5 and 7 seconds on an idle machine, so vitest's 5s default failed them on
 * elapsed time rather than on behaviour -- and failed a DIFFERENT test
 * whenever load shifted, which reads as flake instead of a budget that was
 * never big enough.
 *
 * 30s is chosen to be clear of the slowest case (~7s) with room for a loaded
 * CI runner, while still bounded: a genuinely hung test fails rather than
 * hanging the lane.
 */
export default defineConfig({
  test: {
    // web-server's tests live outside src/, so the service stays
    // self-contained (same reason bags/actions splits its include list).
    include: ["src/**/*.test.ts", "web-server/src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      LOG_LEVEL: "silent",
      ...testDatabaseEnv(),
    },
  },
});
