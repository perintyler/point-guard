/**
 * Barry plans, matched to sessions.
 *
 * Note which "plan" this is: the Barry PLANS BAG (a user's own plans, port
 * 4880), not point-guard's own plans/plan_steps tables, which are delegation
 * execution plans it runs itself. They are unrelated, and conflating them
 * would put internal delegation work in front of a human as "your plans".
 *
 * Read over HTTP rather than by opening ~/.barry/plans.db: that file is held
 * in WAL by its own writers, and reading another service's SQLite out from
 * under it is the incident this codebase already has a standing rule about.
 */
import { createLogger } from "@barry-rocks/logger";
import { git } from "./gitwt.js";

const log = createLogger("point-guard:debrief-plans");

const PLANS_URL_FALLBACK = "http://127.0.0.1:4880";

/**
 * git@github.com:owner/name.git and https://github.com/owner/name.git both
 * become github.com/owner/name.
 *
 * PORTED VERBATIM from bags/plans/src/repo.ts's normalizeRemote. It must stay
 * byte-compatible with that one: this function's whole job is to produce the
 * string the plans bag stored, and a subtle divergence here yields no matches
 * at all rather than an error. A test asserts the two agree.
 */
export function normalizeRemote(remote: string): string | null {
  const ssh = remote.match(/^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)[:/](.+?)(?:\.git)?\/?$/);
  if (!ssh) return null;
  const host = ssh[1]!;
  const path = ssh[2]!.replace(/^\/+/, "");
  if (!path || path.includes("..")) return null;
  return `${host}/${path}`;
}

/** The remote slug for a worktree, or null when it has no origin remote.
 *  Best-effort: a checkout without a remote simply matches no plans. */
export async function remoteSlugFor(worktree: string): Promise<string | null> {
  try {
    const { stdout } = await git(worktree, ["remote", "get-url", "origin"], { allowFailure: true });
    const remote = stdout.trim();
    return remote ? normalizeRemote(remote) : null;
  } catch {
    return null;
  }
}

interface PlansApiPlan {
  id: string;
  title: string;
  status: string;
  repo: string | null;
  updated_at: string;
  progress?: { done: number; total: number; of: string };
}

export interface FetchedPlans {
  /** Open plans the service returned. Empty means it ANSWERED and had none. */
  plans: PlansApiPlan[];
  /** Non-null means we could not ask -- which is not the same as "none", and
   *  the debrief's `sources` field carries that distinction to clients. */
  error: string | null;
  baseUrl: string;
}

/**
 * Open plans (draft + in-progress). Both statuses, because a draft is exactly
 * what someone is usually working from -- 86 of 89 plans are drafts, so
 * filtering to in-progress would show almost nothing.
 */
export async function fetchOpenPlans(baseUrl = process.env.BARRY_PLANS_URL ?? PLANS_URL_FALLBACK): Promise<FetchedPlans> {
  const out: PlansApiPlan[] = [];
  try {
    for (const status of ["in-progress", "draft"]) {
      const res = await fetch(`${baseUrl}/api/plans?status=${status}&limit=100`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return { plans: [], error: `plans service returned ${res.status}`, baseUrl };
      const body = (await res.json()) as { plans?: PlansApiPlan[] };
      out.push(...(body.plans ?? []));
    }
    return { plans: out, error: null, baseUrl };
  } catch (error) {
    log.info(`plans unreachable: ${String(error)}`);
    return { plans: [], error: String(error), baseUrl };
  }
}

/**
 * Re-exported so callers of this module get the matcher alongside the fetch.
 * The implementation lives in debrief.ts because buildDebrief needs it there
 * and this module already imports that one -- keeping a second copy here
 * would let the two drift apart without anything failing.
 */
export { linkPlansForSlug } from "./debrief.js";
