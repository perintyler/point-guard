/**
 * Git plumbing for point-guard: worktree lifecycle, delta enumeration,
 * ancestry proofs, and compare-and-swap publication.
 *
 * Every command is execFile with argv — no shell strings, ever. All effects
 * happen in service-owned worktrees under ~/.barry/worktrees; the user's
 * shared checkout and index are never touched (plan: Integration and Cleanup).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 60_000;

export async function git(
  cwd: string,
  args: string[],
  options?: { timeoutMs?: number; allowFailure?: boolean },
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: options?.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number; message?: string };
    if (options?.allowFailure) {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? String(e.message ?? ""), code: typeof e.code === "number" ? e.code : 1 };
    }
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${e.stderr || e.message}`);
  }
}

export function worktreesRoot(): string {
  return process.env.BARRY_POINT_GUARD_WORKTREES ?? join(homedir(), ".barry", "worktrees");
}

/** Same layout the rest of Barry uses: <root>/<sha1(repo)[0:8]>/<sessionId>. */
export function worktreePathFor(absRepoPath: string, sessionId: string): string {
  const repoHash = createHash("sha1").update(absRepoPath).digest("hex").slice(0, 8);
  return join(worktreesRoot(), repoHash, sessionId);
}

export async function resolveSha(repo: string, ref: string): Promise<string> {
  const { stdout } = await git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return stdout.trim();
}

export async function commonDir(repo: string): Promise<string> {
  const { stdout } = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return stdout.trim();
}

/**
 * Create the per-attempt worktree at the recorded baseline. Branch is always
 * barry/<sessionId> — the same convention every other Barry surface expects.
 */
export async function createWorktree(input: {
  repo: string;
  sessionId: string;
  baselineSha: string;
}): Promise<{ path: string; branch: string }> {
  const path = worktreePathFor(input.repo, input.sessionId);
  const branch = `barry/${input.sessionId}`;
  mkdirSync(dirname(path), { recursive: true });
  await git(input.repo, ["worktree", "add", path, "-b", branch, input.baselineSha]);
  carryIdentityBinding(input.repo, path);
  return { path, branch };
}

/**
 * A worktree is its own git root, so identity resolution stops at its edge and
 * silently falls back to the global identity — wrong bags/traits/scope. Copy
 * the bare-file `.barry` binding (only that form; a directory-form binding is
 * repo content and already checked out). Best-effort, mirroring servers/api.
 */
function carryIdentityBinding(repo: string, worktreePath: string): void {
  try {
    const source = join(repo, ".barry");
    if (existsSync(source) && statSync(source).isFile() && !existsSync(join(worktreePath, ".barry"))) {
      copyFileSync(source, join(worktreePath, ".barry"));
    }
  } catch {
    // Losing the binding degrades identity, not correctness; never fail the
    // worktree over it.
  }
}

/**
 * Removal is best-effort and NEVER --force on a dirty tree by default:
 * unreadable/dirty means retain-and-alert (plan: Cleanup). Returns false when
 * the worktree was retained.
 */
export async function removeWorktreeSafe(repo: string, worktreePath: string, branch: string): Promise<boolean> {
  const status = await git(worktreePath, ["status", "--porcelain"], { allowFailure: true });
  if (status.code !== 0 || status.stdout.trim() !== "") return false;
  const removed = await git(repo, ["worktree", "remove", worktreePath], { allowFailure: true });
  if (removed.code !== 0) return false;
  await git(repo, ["branch", "-D", branch], { allowFailure: true });
  return true;
}

export interface ChangedFile {
  status: string;
  path: string;
  oldPath?: string;
}

/**
 * Full baseline->candidate delta via NUL-delimited name-status — renames,
 * deletions, modes and all. `--stat` is display output and must never feed a
 * scope check (plan: Artifact and environment).
 */
export async function enumerateDelta(repo: string, baseSha: string, headSha: string): Promise<ChangedFile[]> {
  const { stdout } = await git(repo, [
    "diff",
    "--name-status",
    "--find-renames",
    "-z",
    `${baseSha}..${headSha}`,
  ]);
  const parts = stdout.split("\0").filter((p) => p.length > 0);
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < parts.length) {
    const status = parts[i];
    if (status.startsWith("R") || status.startsWith("C")) {
      files.push({ status, oldPath: parts[i + 1], path: parts[i + 2] });
      i += 3;
    } else {
      files.push({ status, path: parts[i + 1] });
      i += 2;
    }
  }
  return files;
}

export async function fullDiff(repo: string, baseSha: string, headSha: string, maxBytes = 2 * 1024 * 1024): Promise<{ diff: string; truncated: boolean }> {
  const { stdout } = await git(repo, ["diff", "--find-renames", `${baseSha}..${headSha}`], { timeoutMs: 120_000 });
  if (Buffer.byteLength(stdout, "utf8") > maxBytes) {
    // An oversized judge input blocks automatic acceptance rather than being
    // silently truncated into a review of half the change.
    return { diff: stdout.slice(0, maxBytes), truncated: true };
  }
  return { diff: stdout, truncated: false };
}

export async function isAncestor(repo: string, maybeAncestor: string, descendant: string): Promise<boolean> {
  const result = await git(repo, ["merge-base", "--is-ancestor", maybeAncestor, descendant], { allowFailure: true });
  return result.code === 0;
}

/** Hash a file's content AS OF a commit — reading the working tree would let a
 * post-check mutation slip by. Missing file hashes to "absent". */
export async function hashFileAtCommit(repo: string, sha: string, path: string): Promise<string> {
  const result = await git(repo, ["show", `${sha}:${path}`], { allowFailure: true });
  if (result.code !== 0) return "absent";
  return createHash("sha256").update(result.stdout).digest("hex");
}

export async function isTreeClean(worktreePath: string): Promise<boolean> {
  const { stdout } = await git(worktreePath, ["status", "--porcelain", "-z"]);
  return stdout.trim().length === 0;
}

/**
 * Minimal glob → RegExp for scope envelopes: `**` crosses directories, `*`
 * stays within one segment. Deliberately tiny — the envelope language is ours,
 * so we keep it small enough to reason about instead of importing a globber
 * whose corner cases nobody audited.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (".+^${}()|[]\\".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

export function outOfScope(files: ChangedFile[], scopeGlobs: string[]): ChangedFile[] {
  const regexes = scopeGlobs.map(globToRegExp);
  return files.filter((f) => {
    const paths = [f.path, ...(f.oldPath ? [f.oldPath] : [])];
    return !paths.every((p) => regexes.some((r) => r.test(p)));
  });
}

/**
 * Compare-and-swap publication (plan invariant #4). `git update-ref` with the
 * expected old value refuses when a competing writer advanced the target —
 * the caller re-integrates; it never "refreshes" the expected SHA and retries
 * blind.
 */
export async function casPublish(repo: string, targetRef: string, newSha: string, expectedOldSha: string): Promise<{ published: boolean; error?: string }> {
  const result = await git(repo, ["update-ref", targetRef, newSha, expectedOldSha], { allowFailure: true });
  if (result.code === 0) return { published: true };
  return { published: false, error: result.stderr.trim() || "update-ref refused" };
}

/** Merge the accepted commit into an integration worktree sitting at the
 * observed target SHA. Returns the merge commit, or null on conflict. */
export async function mergeIntoWorktree(worktreePath: string, acceptedSha: string, message: string): Promise<{ mergedSha: string } | { conflict: true }> {
  const merge = await git(worktreePath, ["merge", "--no-ff", "-m", message, acceptedSha], { allowFailure: true });
  if (merge.code !== 0) {
    await git(worktreePath, ["merge", "--abort"], { allowFailure: true });
    return { conflict: true };
  }
  const { stdout } = await git(worktreePath, ["rev-parse", "HEAD"]);
  return { mergedSha: stdout.trim() };
}

/** A detached integration worktree at an exact SHA — no branch, so nothing to
 * race and nothing to clean up but the directory. */
export async function createDetachedWorktree(repo: string, sha: string, name: string): Promise<string> {
  const path = worktreePathFor(repo, name);
  mkdirSync(dirname(path), { recursive: true });
  await git(repo, ["worktree", "add", "--detach", path, sha]);
  return path;
}

export interface RegisteredWorktree {
  path: string;
  /** The trailing path segment — worker worktrees are named by
   * barrySessionId (worktreePathFor), so this doubles as that id. */
  name: string;
  branch?: string;
}

/** Git's own worktree registry for a repo, parsed from --porcelain. This is
 * ground truth for "what worktrees exist", independent of point-guard's own
 * bookkeeping — exactly what startup pruning needs to cross-reference
 * against, since a crash leaves the directory behind with no other record
 * of it (the `runs` table has no worktree_path column; the path is only
 * ever reconstructed via worktreePathFor(repo, barrySessionId)). */
export async function listRegisteredWorktrees(repo: string): Promise<RegisteredWorktree[]> {
  const { stdout } = await git(repo, ["worktree", "list", "--porcelain"]);
  const entries: RegisteredWorktree[] = [];
  let current: Partial<RegisteredWorktree> = {};
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) entries.push(current as RegisteredWorktree);
      const path = line.slice("worktree ".length);
      current = { path, name: path.split("/").filter(Boolean).pop() ?? path };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "") {
      if (current.path) entries.push(current as RegisteredWorktree);
      current = {};
    }
  }
  if (current.path) entries.push(current as RegisteredWorktree);
  // git resolves symlinks in its own output (notably macOS's /var ->
  // /private/var), so comparing against the caller's un-resolved `repo`
  // string by simple equality misses the main working copy and treats it
  // as prunable. realpathSync both sides before comparing.
  const realRepo = realpathSafe(repo) ?? repo;
  return entries.filter((e) => (realpathSafe(e.path) ?? e.path) !== realRepo);
}

function realpathSafe(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null; // path may already be gone; caller decides what that means
  }
}

/**
 * Prune worktrees left behind by a crashed attempt or integration. `keepIds`
 * is the set of barrySessionIds/names that must be RETAINED regardless of
 * tree state (e.g. an `accepted`-but-not-yet-merged delegation's worker
 * worktree — acceptance is not permission to destroy an unexamined
 * worktree, same rule `removeWorktreeSafe` already enforces). Everything
 * else is removed only if `removeWorktreeSafe` finds it clean; a dirty or
 * unreadable tree is retained and reported, never forced.
 *
 * Best-effort by design: a failure here degrades to "an extra directory on
 * disk", never to a blocked startup. Reused branch name is derived from git
 * itself (not point-guard's `barry/<id>` convention) so this also cleans up
 * correctly for the detached (branchless) integration worktrees.
 */
export async function pruneOrphanedWorktrees(
  repo: string,
  keepIds: Set<string>,
): Promise<{ pruned: string[]; retained: string[] }> {
  const pruned: string[] = [];
  const retained: string[] = [];
  let registered: RegisteredWorktree[];
  try {
    registered = await listRegisteredWorktrees(repo);
  } catch {
    return { pruned, retained }; // repo unreadable — nothing to do, nothing to block
  }
  for (const entry of registered) {
    if (keepIds.has(entry.name)) continue;
    const removed = await removeWorktreeSafe(repo, entry.path, entry.branch ?? "").catch(() => false);
    if (removed) pruned.push(entry.path);
    else retained.push(entry.path);
  }
  // Detached worktrees leave no branch to delete, but `git worktree remove`
  // can leave stale admin entries behind after an external deletion; prune
  // is the standard git-recommended cleanup for exactly that.
  await git(repo, ["worktree", "prune"], { allowFailure: true });
  return { pruned, retained };
}
