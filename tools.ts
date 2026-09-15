/**
 * Point-guard's MCP surface. Thin HTTP clients to the point-guard service —
 * the service is the ONLY writer of point-guard.db (one owner per database),
 * so these tools never open SQLite themselves.
 *
 * The recursion defense's hard half lives here: a delegation-spawned session
 * (metadata.source === "point-guard") is refused `delegate_task`, and a
 * caller whose session cannot be resolved is refused too — fail closed.
 */
import { PROVIDER_IDS } from "@barry-rocks/agent-runtime";
import { z } from "zod";
import { defineTool } from "@barry-rocks/tools";
import { assertNotWorkerSession } from "./src/recursion-gate.js";

const SERVICE_URL = process.env.BARRY_POINT_GUARD_URL ?? "http://127.0.0.1:3868";

async function service(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const secret = process.env.BARRY_SECRET ?? "";
  const response = await fetch(`${SERVICE_URL}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${secret}`,
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`point-guard service ${path} -> ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`);
  }
  return payload;
}


export const delegateTask = defineTool({
  namespace: "point-guard",
  access: "write",
  name: "delegate_task",
  description:
    "Hand a bounded, independently verifiable coding subtask to a point-guard worker. " +
    "Returns a delegation id immediately; the worker runs in the background — poll check_delegations.",
  schema: {
    objective: z.string().min(1).describe("The subtask, complete enough for a fresh agent with no other context."),
    repo: z.string().min(1).describe("Absolute path of the git repo to work in."),
    file_scope: z.array(z.string()).min(1).describe("Globs the change must stay inside, e.g. ['src/**','test/**']"),
    requirements: z
      .array(z.object({ id: z.string(), text: z.string() }))
      .min(1)
      .describe("Acceptance requirements by id; all are mandatory."),
    acceptance_checks: z
      .array(z.object({ id: z.string(), argv: z.array(z.string()).min(1), expect_tests: z.boolean().optional() }))
      .min(1)
      .describe("Commands (argv form) that must exit 0 in the candidate checkout."),
    protected_files: z.array(z.string()).optional().describe("Files the worker must not change (tests, configs); tampering auto-rejects."),
    provider: z.enum(PROVIDER_IDS).optional(),
    timeout_s: z.number().int().positive().max(3600).optional(),
  },
  handler: async (params, context) => {
    await assertNotWorkerSession(context);
    const brief = {
      objective: params.objective,
      requirements: params.requirements.map((r) => ({ id: r.id, text: r.text, mandatory: true })),
      repo: params.repo,
      fileScope: params.file_scope,
      acceptanceChecks: params.acceptance_checks.map((c) => ({
        id: c.id,
        argv: c.argv,
        expectTests: c.expect_tests ?? false,
      })),
      protectedFiles: params.protected_files ?? [],
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.timeout_s ? { workerDeadlineMs: params.timeout_s * 1000 } : {}),
    };
    return service("/delegations", { method: "POST", body: { brief } });
  },
});

export const checkDelegations = defineTool({
  namespace: "point-guard",
  access: "read",
  name: "check_delegations",
  description: "List point-guard delegations with state, attempts, and last outcome.",
  schema: {
    state: z.string().optional().describe("Filter by state, e.g. running, accepted, blocked."),
  },
  handler: async ({ state }) => service(`/delegations${state ? `?state=${encodeURIComponent(state)}` : ""}`),
});

export const readReport = defineTool({
  namespace: "point-guard",
  access: "read",
  name: "read_report",
  description: "Read the worker's structured report for a delegation.",
  schema: { delegation_id: z.string().min(1) },
  handler: async ({ delegation_id }) => service(`/delegations/${encodeURIComponent(delegation_id)}/report`),
});

export const listDelegations = defineTool({
  namespace: "point-guard",
  access: "read",
  name: "list_delegations",
  description: "Full delegation list including terminal states.",
  schema: {},
  handler: async () => service("/delegations?all=1"),
});

export const cancelDelegation = defineTool({
  namespace: "point-guard",
  access: "write",
  name: "cancel_delegation",
  description: "Cancel a queued or blocked delegation.",
  schema: { delegation_id: z.string().min(1) },
  handler: async ({ delegation_id }, context) => {
    await assertNotWorkerSession(context);
    return service(`/delegations/${encodeURIComponent(delegation_id)}/cancel`, { method: "POST", body: {} });
  },
});

const planStepSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  depends_on: z.array(z.string()).default([]),
  file_scope: z.array(z.string()).min(1),
  acceptance_checks: z.array(z.object({ id: z.string(), argv: z.array(z.string()).min(1), expect_tests: z.boolean().optional() })).min(1),
  protected_files: z.array(z.string()).optional(),
  requirements: z.array(z.object({ id: z.string(), text: z.string() })).min(1),
  provider: z.enum(PROVIDER_IDS).optional(),
  model: z.string().optional(),
});

/**
 * The intake surface for work handed to point-guard from ANYWHERE — another
 * agent's session, a human via a different tool entirely. Point-guard does
 * not author plans; it accepts a complete one (a single step with no
 * dependencies is a valid plan of one) and executes the dependency graph
 * exactly as given. This is the same MCP surface delegate_task already
 * lives on — reachable by any session with the point-guard trait.
 */
export const submitPlan = defineTool({
  namespace: "point-guard",
  access: "write",
  name: "submit_plan",
  description:
    "Hand point-guard a plan to execute — one or more steps, each a bounded verifiable unit of work, " +
    "with optional dependencies between them. A single task with no decomposition is a valid one-step plan. " +
    "Point-guard runs the dependency graph (independent steps concurrently, dependents after their " +
    "prerequisites merge) and reports back via check_plan. It does not reorder or rewrite the steps it is given.",
  schema: {
    plan_id: z.string().optional().describe("Idempotency key — resubmitting the same plan_id will not duplicate already-dispatched work."),
    repo: z.string().min(1).describe("Absolute path of the git repo."),
    target_ref: z.string().optional().describe("Defaults to refs/heads/master."),
    steps: z.array(planStepSchema).min(1).max(50),
  },
  handler: async (params, context) => {
    await assertNotWorkerSession(context);
    const plan = {
      planId: params.plan_id,
      repo: params.repo,
      ...(params.target_ref ? { targetRef: params.target_ref } : {}),
      steps: params.steps.map((s) => ({
        id: s.id,
        text: s.text,
        dependsOn: s.depends_on,
        fileScope: s.file_scope,
        acceptanceChecks: s.acceptance_checks.map((c) => ({ id: c.id, argv: c.argv, expectTests: c.expect_tests ?? false })),
        protectedFiles: s.protected_files ?? [],
        requirements: s.requirements.map((r) => ({ id: r.id, text: r.text, mandatory: true })),
        ...(s.provider ? { provider: s.provider } : {}),
        ...(s.model ? { model: s.model } : {}),
      })),
    };
    return service("/plans", { method: "POST", body: { plan } });
  },
});

export const checkPlan = defineTool({
  namespace: "point-guard",
  access: "read",
  name: "check_plan",
  description: "Report per-step status for a plan — queued/in_progress/done/skipped/failed — and each step's retrospective when present. The primary way a submitter — which may be a different session than the one that dispatched the plan — learns what happened.",
  schema: { plan_id: z.string().min(1) },
  handler: async ({ plan_id }) => service(`/plans/${encodeURIComponent(plan_id)}`),
});
