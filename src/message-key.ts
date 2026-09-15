/**
 * POST /message's model-call credential resolution — declared in bag.yaml,
 * resolved at request time (never cached across requests: a rotated key
 * should take effect on the next message, not require a restart).
 *
 * The MANIFEST is the source of truth for what this needs:
 * `OPENAI_API_KEY: {source: vault}` (a secret, resolved through the active
 * identity's vault access — never written into the plist, since a
 * plist-frozen secret outlives rotation). Process env overrides for dev/
 * tests.
 *
 * Every failure names the exact missing link, because "messaging offline"
 * with no reason is a check that cannot fail distinguishably.
 */
import { fileURLToPath } from "node:url";
import { createLogger } from "@barry-rocks/logger";

const log = createLogger("point-guard:message-key");

// server/src runs under tsx (never esbuild-bundled — only tools.ts is), so
// import.meta.url survives and the bag root is two levels up from src.
const BAG_DIR = fileURLToPath(new URL("..", import.meta.url));
const SERVICE_NAME = "point-guard";

export type MessageCredentials =
  | { ok: true; apiKey: string; source: "env" | "manifest" }
  | { ok: false; reason: string };

export interface ManifestMessageEnv {
  vaultEntries: Array<{ name: string; item: string; field: string; required: boolean }>;
}

export interface KeyResolverDeps {
  env?: NodeJS.ProcessEnv;
  loadManifestEnv?: () => Promise<ManifestMessageEnv>;
  /**
   * Vault access from the active identity (or BARRY_POINT_GUARD_IDENTITY).
   * Resolves to null when there is no vault to read; `unknown` already
   * admits null, so the absence is documented here rather than spelled in
   * the type.
   */
  loadVaultConfig?: () => Promise<unknown>;
  resolveVault?: (
    entries: ManifestMessageEnv["vaultEntries"],
    vaultConfig: unknown,
  ) => Promise<Record<string, string>>;
}

async function defaultLoadManifestEnv(): Promise<ManifestMessageEnv> {
  const { parseManifest, vaultServiceEnvEntries } = await import("@barry-rocks/bags");
  const manifest = parseManifest(BAG_DIR);
  // At parse level `services` is the manifest's map form (the loader is what
  // flattens it to an array with `name` merged in).
  const service = manifest?.services?.[SERVICE_NAME];
  const vars = service?.env ?? [];
  return { vaultEntries: vaultServiceEnvEntries(vars) };
}

async function defaultLoadVaultConfig(env: NodeJS.ProcessEnv): Promise<unknown> {
  const { Users, Identities } = await import("@barry-rocks/db");
  const { getVaultConfig } = await import("@barry-rocks/secrets");
  const user = await Users.getFirst();
  if (!user) return null;
  const name = env.BARRY_POINT_GUARD_IDENTITY ?? (user.settings as { defaultBarry?: string } | null)?.defaultBarry;
  if (!name) return null;
  const identity = await Identities.getByName(user.id, name);
  if (!identity) return null;
  return getVaultConfig(identity.metadata) ?? null;
}

async function defaultResolveVault(
  entries: ManifestMessageEnv["vaultEntries"],
  vaultConfig: unknown,
): Promise<Record<string, string>> {
  const { buildVaultResolver } = await import("@barry-rocks/secrets");
  const resolver = await buildVaultResolver(vaultConfig as Parameters<typeof buildVaultResolver>[0]);
  if (!resolver) throw new Error("vault credentials absent from Keychain (run `barry heir` provisioning?)");
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const item = (await resolver(entry.item)) as Record<string, string | null> | null;
    const value = item?.[entry.field] ?? undefined;
    if (value) out[entry.name] = value;
  }
  return out;
}

export async function resolveMessageCredentials(deps: KeyResolverDeps = {}): Promise<MessageCredentials> {
  const env = deps.env ?? process.env;

  // 1. Full env override (dev/tests).
  if (env.OPENAI_API_KEY) {
    return { ok: true, apiKey: env.OPENAI_API_KEY, source: "env" };
  }

  // 2. The bag's own declaration.
  const loadManifestEnv = deps.loadManifestEnv ?? defaultLoadManifestEnv;
  let manifestEnv: ManifestMessageEnv;
  try {
    manifestEnv = await loadManifestEnv();
  } catch (error) {
    return { ok: false, reason: `cannot read the bag manifest: ${String(error)}` };
  }

  const keyEntry = manifestEnv.vaultEntries.find((e) => e.name === "OPENAI_API_KEY");
  if (!keyEntry) {
    return {
      ok: false,
      reason: "bag.yaml declares no OPENAI_API_KEY vault source and the env carries no key — the manifest is the contract; declare it there",
    };
  }

  const loadVaultConfig = deps.loadVaultConfig ?? (() => defaultLoadVaultConfig(env));
  let vaultConfig: unknown;
  try {
    vaultConfig = await loadVaultConfig();
  } catch (error) {
    return { ok: false, reason: `identity/vault lookup failed: ${String(error)}` };
  }
  if (!vaultConfig) {
    return {
      ok: false,
      reason:
        "no vault access: the active identity has no vault configured " +
        "(set BARRY_POINT_GUARD_IDENTITY to one that does, or provision with `barry heir`)",
    };
  }

  const resolveVault = deps.resolveVault ?? defaultResolveVault;
  let resolved: Record<string, string>;
  try {
    resolved = await resolveVault([keyEntry], vaultConfig);
  } catch (error) {
    return { ok: false, reason: `vault resolution failed: ${String(error)}` };
  }

  const apiKey = resolved[keyEntry.name];
  if (!apiKey) {
    return {
      ok: false,
      reason:
        `vault item "${keyEntry.item}" (field "${keyEntry.field}") is missing or empty ` +
        `(fix: barry identity env set OPENAI_API_KEY --source vault)`,
    };
  }
  log.info(`message key resolved from vault item "${keyEntry.item}"`);
  return { ok: true, apiKey, source: "manifest" };
}
