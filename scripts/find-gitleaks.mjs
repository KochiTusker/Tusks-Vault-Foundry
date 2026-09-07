// Resolve the gitleaks binary path. Lookup order:
//   1. Worktree-local .bin/gitleaks(.exe)
//   2. Main-repo .bin/gitleaks(.exe) (so a binary dropped in the primary
//      checkout's .bin/ is also visible from linked worktrees)
//   3. System PATH
//
// Returns the resolved path (or "gitleaks" for PATH lookup) on success,
// or null when gitleaks isn't available. Callers MUST handle null
// gracefully — gitleaks is an optional second layer, not a hard dep.
//
// To match Tusks-Tomes, install gitleaks 8.30.1. The audit scripts don't
// pin a version themselves, so newer gitleaks releases also work.
import { existsSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = path.resolve(__dirname, "..");
const BIN_NAME = process.platform === "win32" ? "gitleaks.exe" : "gitleaks";

function mainRepoRoot() {
  // git-common-dir resolves to the main .git/ even from a linked worktree.
  // The repo's working tree lives one level up from that.
  try {
    const commonDir = execSync("git rev-parse --git-common-dir", {
      cwd: WORKTREE_ROOT,
      encoding: "utf-8",
    }).trim();
    const absoluteCommon = path.isAbsolute(commonDir)
      ? commonDir
      : path.resolve(WORKTREE_ROOT, commonDir);
    return path.dirname(absoluteCommon);
  } catch {
    return null;
  }
}

export function findGitleaks() {
  const candidates = [
    path.join(WORKTREE_ROOT, ".bin", BIN_NAME),
  ];
  const main = mainRepoRoot();
  if (main && main !== WORKTREE_ROOT) {
    candidates.push(path.join(main, ".bin", BIN_NAME));
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  try {
    execSync(process.platform === "win32" ? "where gitleaks" : "command -v gitleaks", {
      stdio: "ignore",
    });
    return "gitleaks";
  } catch {
    return null;
  }
}

export function gitleaksVersion(binary) {
  try {
    return execSync(`"${binary}" version`, { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}
