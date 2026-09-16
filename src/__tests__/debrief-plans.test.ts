/**
 * Plan matching. The rule under test is not "does it find plans" but "does it
 * refuse to overstate what it found" -- a repo match is not ownership, and
 * the port of the plans bag's slug normalization must agree with the original
 * exactly or it silently matches nothing.
 */
import { describe, it, expect } from "vitest";
import { normalizeRemote as ported, linkPlansForSlug } from "../debrief-plans.js";
// Imported by relative path across repos on purpose: the point of this test
// is to compare against the REAL implementation, and a copy would agree with
// itself forever. It assumes ~/repos/bags/plans is checked out beside this
// one -- the same sibling-checkout assumption package.json's link: deps
// already make. If plans is absent the import fails loudly, which is the
// correct outcome: this check cannot be run, rather than silently passing.
import { normalizeRemote as original } from "../../../plans/src/repo.js";
import { PLAN_STALENESS_MS } from "../debrief.js";

const NOW = 1_800_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

function plan(over: Record<string, unknown> = {}) {
  return {
    id: "plan_abc",
    title: "A plan",
    status: "draft",
    repo: "github.com/perintyler/barry-dev",
    updated_at: iso(NOW - 1000),
    progress: { done: 1, total: 4, of: "spec" },
    ...over,
  } as never;
}

describe("normalizeRemote agrees with the plans bag's own", () => {
  // Two packages deriving the same concept independently is exactly the
  // "sources diverge" case worth testing: if these drift, point-guard
  // produces a slug the plans bag never stored and matches nothing at all --
  // which looks like "no plans" rather than like a bug.
  const cases = [
    "git@github.com:perintyler/barry-dev.git",
    "https://github.com/perintyler/barry-dev.git",
    "https://github.com/perintyler/barry-dev",
    "ssh://git@github.com/perintyler/barry-dev.git",
    "git@gitlab.com:group/sub/project.git",
    "not a remote at all",
  ];

  for (const remote of cases) {
    it(`agrees on ${remote}`, () => {
      expect(ported(remote)).toBe(original(remote));
    });
  }
});

describe("linkPlansForSlug", () => {
  it("links a plan naming the same repo", () => {
    const links = linkPlansForSlug({ plans: [plan()], baseUrl: "http://x" }, "github.com/perintyler/barry-dev", NOW);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ id: "plan_abc", title: "A plan" });
  });

  it("labels every link match:'repo', never 'session'", () => {
    // Guards the honesty rule against a well-meaning future "improvement":
    // a repo match must never be presented as this session owning the plan.
    const links = linkPlansForSlug({ plans: [plan()], baseUrl: "http://x" }, "github.com/perintyler/barry-dev", NOW);
    expect(links.every((l) => l.match === "repo")).toBe(true);
  });

  it("attaches the same plan to every session in that repo -- and that is why match matters", () => {
    const slug = "github.com/perintyler/barry-dev";
    const a = linkPlansForSlug({ plans: [plan()], baseUrl: "http://x" }, slug, NOW);
    const b = linkPlansForSlug({ plans: [plan()], baseUrl: "http://x" }, slug, NOW);
    expect(a[0].id).toBe(b[0].id);
    expect(a[0].match).toBe("repo");
  });

  it("does not link a plan from a different repo", () => {
    const links = linkPlansForSlug({ plans: [plan()], baseUrl: "http://x" }, "github.com/perintyler/something-else", NOW);
    expect(links).toHaveLength(0);
  });

  it("links nothing when the session has no remote slug", () => {
    expect(linkPlansForSlug({ plans: [plan()], baseUrl: "http://x" }, null, NOW)).toHaveLength(0);
  });

  it("drops a plan untouched for longer than the staleness window", () => {
    const stale = plan({ updated_at: iso(NOW - PLAN_STALENESS_MS - 1) });
    expect(linkPlansForSlug({ plans: [stale], baseUrl: "http://x" }, "github.com/perintyler/barry-dev", NOW)).toHaveLength(0);
  });

  it("drops a plan whose updated_at is unparseable rather than treating it as fresh", () => {
    const bad = plan({ updated_at: "not a date" });
    expect(linkPlansForSlug({ plans: [bad], baseUrl: "http://x" }, "github.com/perintyler/barry-dev", NOW)).toHaveLength(0);
  });
});
