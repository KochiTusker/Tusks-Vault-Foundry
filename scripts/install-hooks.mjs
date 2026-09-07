#!/usr/bin/env node
// Mirror the canonical hooks from scripts/hooks/ into the repository's
// hooks directory. Hooks live outside the tracked tree, so a fresh clone
// (and every linked worktree) starts without them — run this once per
// machine, and re-run after any hook change.
//
// Worktree-aware: hooks live under the COMMON git dir, shared across all
// worktrees, so installing from any checkout covers them all. Idempotent:
// re-running overwrites with the current canonical copy.
import { execFileSync } from "node:child_process";
import { copyFileSync, chmodSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hooksSource = path.join(__dirname, "hooks");

let commonDir;
try {
  commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    encoding: "utf-8",
    cwd: path.resolve(__dirname, ".."),
  }).trim();
} catch {
  console.error("Not in a git repo.");
  process.exit(1);
}
const absCommon = path.isAbsolute(commonDir)
  ? commonDir
  : path.resolve(__dirname, "..", commonDir);
const hooksDir = path.join(absCommon, "hooks");
mkdirSync(hooksDir, { recursive: true });

let installed = 0;
for (const name of readdirSync(hooksSource)) {
  const src = path.join(hooksSource, name);
  const dst = path.join(hooksDir, name);
  copyFileSync(src, dst);
  try {
    chmodSync(dst, 0o755);
  } catch {
    /* Windows: execute bits are a no-op; git-bash runs hooks regardless */
  }
  console.log(`✓ installed ${name} → ${dst}`);
  installed++;
}

if (installed === 0) {
  console.error("No hooks found in scripts/hooks/ — nothing installed.");
  process.exit(1);
}
