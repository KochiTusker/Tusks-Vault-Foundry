#!/usr/bin/env node
/**
 * Pre-push gate. Reads git's standard pre-push stdin format and runs the full
 * multi-layer scanner against the commits being pushed. See
 * scripts/lib/secret-scanner.mjs for the individual layers.
 *
 * RUNS ON EVERY REMOTE. It used to run only for the public destination and
 * skipped the dev repository outright. That treated a private remote as out of
 * scope, which the project's own threat model does not: dev is second-line
 * defence, not a free pass, and every commit there is one release away from
 * being published. A protected name reaching dev unscanned is already written
 * down — it is merely not public yet.
 *
 * What differs by destination is SEVERITY, not whether the scan happens:
 *
 *   public  — `.private-names` is required; absent, the push is refused. The
 *             fast-forward guard runs too.
 *   other   — an absent denylist warns, so a contributor without the
 *             maintainer's list can still push. Everything present is still
 *             scanned, and content findings still block.
 *
 * Usage: node scripts/audit-push-range.mjs [--public]
 *
 * Stdin format (one line per ref being pushed):
 *   <local-ref> SP <local-sha> SP <remote-ref> SP <remote-sha>
 *
 * Exit code:
 *   0 — clean, push proceeds
 *   1 — at least one blocking finding, push is aborted
 *
 * Hooks should be quiet on the happy path; warnings (deliberate re-root,
 * absent optional layers) are printed regardless because they need human
 * eyes even when nothing blocks.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runAllChecks, dedupeFindings, printFindings } from "./lib/secret-scanner.mjs";
import { checkFastForward, REROOT_ENV } from "./lib/fast-forward-guard.mjs";

const ZERO_SHA = "0000000000000000000000000000000000000000";

/** Whether this push is bound for the public remote. The HOOK decides, because
 *  it is the only place holding the remote name and URL; re-deriving it here
 *  would create a second answer to the same question. */
const PUBLIC_BOUND = process.argv.includes("--public");

const stdin = readFileSync(0, "utf-8");
const refLines = stdin.split("\n").filter(l => l.trim());

if (refLines.length === 0) {
  process.exit(0);
}

let blocking = [];
let warnings = [];
let gitleaksRan = false;

for (const line of refLines) {
  const [, localSha, , remoteSha] = line.split(" ");
  if (localSha === ZERO_SHA) continue; // deletion — content scan is moot (the ff-guard still sees it)

  // New branch on the remote: scan everything reachable from local-sha.
  // Update: scan only the new commits.
  const range = remoteSha === ZERO_SHA ? localSha : `${remoteSha}..${localSha}`;

  let result;
  try {
    result = runAllChecks(range, { publicBound: PUBLIC_BOUND });
  } catch (err) {
    // resolvePrivateNames throws on the public path when the denylist file
    // is missing — an unscanned push must never read as a safe one.
    blocking.push({ layer: "private-name", file: "", commit: "", detail: (err instanceof Error ? err.message : String(err)) });
    continue;
  }
  blocking.push(...result.blocking);
  warnings.push(...result.warnings);
  if (result.gitleaksAvailable) gitleaksRan = true;
}

// Fast-forward guard — refs/heads/main only. A re-root is allowed only when
// explicitly asked for via the environment, and even then it is announced
// rather than silent.
//
// Public only: the linear-history rule protects the in-app updater's
// `git pull --ff-only`, which tracks public alone. Dev branches rebase and
// force-push routinely, and a guard firing on those would be bypassed by
// habit — taking the content scan, which matters everywhere, out with it.
if (PUBLIC_BOUND) {
  const ffFindings = checkFastForward(
    refLines,
    args => spawnSync("git", args).status ?? 1,
    { allowReroot: process.env[REROOT_ENV] === "1" }
  );
  blocking.push(...ffFindings.filter(f => !f.warning));
  warnings.push(...ffFindings.filter(f => f.warning));
}

blocking = dedupeFindings(blocking);
warnings = dedupeFindings(warnings);

if (warnings.length > 0) {
  console.error("");
  console.error(`⚠  ${warnings.length} warning(s) on this push:`);
  console.error("");
  printFindings(warnings);
}

if (blocking.length === 0) {
  if (!gitleaksRan) {
    console.error("(gitleaks layer skipped — binary not found at .bin/ or on PATH.");
    console.error(" Install gitleaks 8.30.1 for the second-layer scan.)");
  }
  process.exit(0);
}

console.error("");
console.error("⚠  Push BLOCKED — the scanner reported finding(s) in the commits being pushed.");
console.error("");
printFindings(blocking);
console.error("To unblock:");
console.error("  - Credential findings: rotate the credential at the provider first —");
console.error("    it has been exposed in your git history — then rewrite history to");
console.error("    remove it (git filter-repo or BFG) and re-run the push.");
console.error("  - Identity / content findings: fix the flagged lines and rebuild the release.");
console.error("  - Fast-forward findings: build the release as a child of the published");
console.error("    commit (npm run release does this).");
console.error("");
console.error("To bypass (DANGEROUS — only if you have verified every finding is a false");
console.error("positive), use:  git push --no-verify");
console.error("");
process.exit(1);
