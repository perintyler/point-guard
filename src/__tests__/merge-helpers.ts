/** Re-exports for merge tests, plus a failure-tolerant git helper. */
export { casPublish, commonDir, resolveSha } from "../gitwt.js";
import { execFileSync } from "node:child_process";

export function gitfSafe(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}
