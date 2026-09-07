#!/usr/bin/env node
/**
 * Publish a release to the `public` remote (Tusks-Vault-Foundry).
 *
 * Ported from Tusk's Vault, which publishes the same way. Two differences,
 * both forced by Foundry's package registry:
 *
 *   - The tag is `foundry-v<version>`, because `module/module.json` bakes
 *     `releases/download/foundry-v<version>/module.zip` into every install as
 *     the download URL. A tag that does not match that string publishes a
 *     manifest pointing at an asset nobody can fetch.
 *   - The version is not an argument you choose. It is read from
 *     `module/module.json`, and a version passed on the command line has to
 *     agree with it — the manifest is the thing Foundry actually reads.
 *
 * Pushing the branch is only half a Foundry release. The registry fetches
 * `module.zip` from a GitHub *Release*, which is a separate object from the
 * tag this script pushes; the closing output says what to do next, and
 * RELEASING.md has the whole sequence.
 *
 * Public history is ONE parentless root, then strictly linear: the first
 * release created the root, and every release since is an ordinary child of
 * the published public/main. The isolation from dev history is permanent
 * after the root — a release commit's parent is a public commit, so no dev
 * commit is ever reachable from public.
 *
 * WHY LINEAR, for this repository specifically. Foundry does not install this
 * module from git and never reads its history: it fetches the `manifest` URL,
 * compares versions, and downloads a zip. So a re-root breaks no install here,
 * and the reason is not the one Vault has (whose users DO update by
 * `git pull --ff-only`, which a re-root breaks for every install at once).
 *
 * It is linear because the public history is the reviewable record — of what
 * shipped, and when — and because anyone who clones it (a contributor, a
 * packager, whoever reviews the package submission) gets a broken pull from a
 * re-root. Tags and their release assets survive a re-root, but the commits
 * they point at become unreachable, so the record stops matching the releases.
 *
 * The dev repo (`origin`) is never touched by this script. Day-to-day
 * pushes to dev use plain `git push` and keep full history.
 *
 * Usage:
 *   node scripts/release-to-public.mjs [<version>] ["<summary>"]
 *   node scripts/release-to-public.mjs --dry-run [<version>] ["<summary>"]
 *   node scripts/release-to-public.mjs --no-tag [<version>] ["<summary>"]
 *
 * <version> is optional and defaults to module/module.json's. Passing it is
 * a way of saying out loud which version you think you are shipping.
 *
 * Behavior:
 *   1. Verifies working tree is clean and you're on `main`.
 *   2. Verifies the `public` remote is configured, then fetches public/main
 *      (aborts if unreachable — descent must be verifiable before a push).
 *   3. Builds the release TREE in a temporary index: the current HEAD tree
 *      minus every path in .public-exclude. The working tree is never
 *      touched — no orphan branch, no checkout, nothing to clean up.
 *   4. Creates the release commit with `git commit-tree`, parented on the
 *      fetched public/main (or parentless for the very first release).
 *   5. Tags it (unless --no-tag) and pushes commit + tag. The push is a
 *      plain fast-forward; the pre-push hook independently verifies that
 *      and runs the full scanner suite.
 *
 * A deliberate re-root (history rewrite) requires TUSKS_ALLOW_REROOT=1 and
 * force-pushes over the published branch. Every existing install's updater
 * breaks when that happens — it is a one-way door, spend it knowingly.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readPublicExcludes } from "./lib/public-exclude.mjs";

const SOURCE_BRANCH_REQUIRED = "main";
const PUBLIC_REMOTE = "public";
const PUBLIC_REMOTE_URL = "https://github.com/KochiTusker/Tusks-Vault-Foundry.git";

/** The tag prefix Foundry's download URL is built around. Changing it means
 *  changing `download` in module/module.json in the same commit, or the
 *  registry serves a manifest whose artifact 404s. */
const TAG_PREFIX = "foundry-v";

// Pin the public-commit identity in code so it can't drift if local
// `git config user.*` is ever changed (e.g. after a re-clone). Same value
// is set as committer too — GitHub's UI shows both. Date is normalised to
// UTC so a release commit doesn't leak the maintainer's local timezone.
// scripts/lib/personal-info-scanner.mjs reads these constants as the trust
// root for the commit-identity layer — keep the assignments regex-readable.
const PUBLIC_AUTHOR_NAME = "KochiTusker";
const PUBLIC_AUTHOR_EMAIL = "68705528+KochiTusker@users.noreply.github.com";

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf-8", ...opts });
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

// ─── Parse argv ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const noTag = argv.includes("--no-tag");
const positional = argv.filter(a => !a.startsWith("--"));
const requested = positional[0];
const summary = positional[1] ?? "";
const allowReroot = process.env.TUSKS_ALLOW_REROOT === "1";

// ─── The manifest is the source of truth ───────────────────────────────────
// Foundry reads module/module.json and nothing else. A release whose tag, whose
// manifest `version` and whose `download` URL do not all agree is the classic
// broken publish: it installs once and never updates, and nothing warns. So the
// version is READ here rather than chosen, and an argument is accepted only so
// it can be checked against what the manifest says.

let manifest;
try {
  manifest = JSON.parse(readFileSync("module/module.json", "utf-8"));
} catch (err) {
  fail(`Could not read module/module.json: ${err instanceof Error ? err.message : String(err)}`);
}

const version = manifest.version;
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(String(version ?? ""))) {
  fail(`module/module.json version "${version}" must be <major>.<minor>.<patch>[-prerelease].`);
}

if (requested && requested.replace(/^v/, "") !== version) {
  fail([
    `You asked for ${requested}, but module/module.json says ${version}.`,
    "",
    "Bump the manifest first — Foundry reads it, not this argument:",
    "  module/module.json  → version, and the tag inside `download`",
    "  package.json        → version",
  ].join("\n"));
}

const tag = `${TAG_PREFIX}${version}`;

// The download URL carries the tag this script is about to create. If the two
// disagree the published manifest points at an asset that will never exist,
// and Foundry reports it as a failed install with no explanation.
if (!String(manifest.download ?? "").includes(`/${tag}/`)) {
  fail([
    `module/module.json's download URL does not reference the tag ${tag}:`,
    `  ${manifest.download}`,
    "",
    `It must contain "/${tag}/", or every install fetches a 404.`,
  ].join("\n"));
}

// ─── Pre-flight checks ─────────────────────────────────────────────────────

const status = git(["status", "--porcelain"]).trim();
if (status) {
  console.error("Working tree has uncommitted changes. Commit or stash first:");
  console.error(status);
  process.exit(1);
}

const sourceBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
if (sourceBranch !== SOURCE_BRANCH_REQUIRED) {
  fail([
    `You're on "${sourceBranch}", not "${SOURCE_BRANCH_REQUIRED}".`,
    `Releases must come from ${SOURCE_BRANCH_REQUIRED}. Switch first:`,
    `  git checkout ${SOURCE_BRANCH_REQUIRED}`,
  ].join("\n"));
}

const remotes = git(["remote"]).split("\n").map(r => r.trim()).filter(Boolean);
if (!remotes.includes(PUBLIC_REMOTE)) {
  fail([
    `"${PUBLIC_REMOTE}" remote isn't configured. Add it:`,
    `  git remote add ${PUBLIC_REMOTE} ${PUBLIC_REMOTE_URL}`,
  ].join("\n"));
}

const localTags = git(["tag", "--list"]).split("\n").map(t => t.trim()).filter(Boolean);
if (!noTag && localTags.includes(tag)) {
  fail([
    `Tag ${tag} already exists locally. Either:`,
    `  - Delete it first:  git tag -d ${tag}`,
    `  - Bump the version in module/module.json and package.json`,
    `  - Run with --no-tag to skip tagging`,
  ].join("\n"));
}

// ─── Resolve the published parent ──────────────────────────────────────────
// Fetch, don't trust a stale local ref: descent is verified against what the
// remote actually serves. A failed fetch aborts — building a release whose
// parent might be wrong is exactly the mistake this script exists to prevent.
// (--dry-run falls back to the last-fetched ref with a warning, so the
// commit can still be inspected offline.)

console.log(`→ Fetching ${PUBLIC_REMOTE}/main to establish the published parent...`);
let parentSha = null;
const fetch = spawnSync("git", ["fetch", PUBLIC_REMOTE, "main"], { encoding: "utf-8" });
if (fetch.status === 0) {
  try {
    parentSha = git(["rev-parse", `refs/remotes/${PUBLIC_REMOTE}/main`]).trim();
  } catch {
    parentSha = null; // remote reachable but branch absent — first release
  }
} else {
  const remoteBranchMissing = /couldn't find remote ref/i.test(fetch.stderr ?? "");
  if (remoteBranchMissing) {
    parentSha = null; // brand-new public repo — this release creates the root
  } else if (dryRun) {
    try {
      parentSha = git(["rev-parse", `refs/remotes/${PUBLIC_REMOTE}/main`]).trim();
      console.log(`  (fetch failed; --dry-run continuing against the last-fetched ${parentSha.slice(0, 7)})`);
    } catch {
      parentSha = null;
      console.log("  (fetch failed and no local ref exists; --dry-run will build a parentless preview)");
    }
  } else {
    fail([
      `Could not fetch ${PUBLIC_REMOTE}/main:`,
      (fetch.stderr ?? "").trim(),
      "",
      "A release must be built as a child of the commit the remote actually",
      "publishes. Restore connectivity and retry.",
    ].join("\n"));
  }
}

if (parentSha && allowReroot) {
  console.log("");
  console.log(`  ⚠  TUSKS_ALLOW_REROOT=1 — building a PARENTLESS commit over the published ${parentSha.slice(0, 7)}.`);
  console.log("     Every existing install's updater will fail after this push.");
  console.log("");
  parentSha = null;
}

console.log(
  parentSha
    ? `  Parent: ${parentSha.slice(0, 7)} (published ${PUBLIC_REMOTE}/main — this release fast-forwards it)`
    : `  Parent: none (this release creates the public root)`
);

// ─── Release-gate reminder ─────────────────────────────────────────────────
// Printed only for the non-dry path. The full gate (tree audit, code
// review, dry-run inspection) is documented in CLAUDE.md → "Release-gate
// rule" and is intended to be completed BEFORE this script runs in non-dry
// mode. This banner is the last-second visible reminder for the case where
// the script is invoked directly.
if (!dryRun) {
  console.log("");
  console.log("  ────────────────────────────────────────────────────────────────");
  console.log("   Release-gate reminder — see docs/dev/release-gate.md.");
  console.log("");
  console.log("   Confirm you have completed, for the exact HEAD SHA below:");
  console.log(`     HEAD: ${git(["rev-parse", "--short", "HEAD"]).trim()}`);
  console.log("     Pass 1 — npm run verify (tests, manifest, tree audit)");
  console.log("     Pass 2 — npm run build, and install the zip into a clean Foundry");
  console.log("     Pass 3 — dry-run inspection (author, date, file list)");
  console.log("");
  console.log("   If any pass is BLOCK and you haven't explicitly overridden it,");
  console.log("   Ctrl+C now.");
  console.log("  ────────────────────────────────────────────────────────────────");
  console.log("");
}

// ─── Build the release tree in a temporary index ───────────────────────────
// The working tree and the real index are never touched: read the HEAD tree
// into a scratch index, strip the dev-only paths from it, write it back out
// as a tree object. (Pre-flight already proved worktree == HEAD, so reading
// HEAD is reading exactly what the maintainer sees on disk.)

const scratchDir = mkdtempSync(path.join(tmpdir(), "vtt-release-"));
const scratchIndex = path.join(scratchDir, "index");
const indexEnv = { ...process.env, GIT_INDEX_FILE: scratchIndex };

let commitSha;
try {
  git(["read-tree", "HEAD"], { env: indexEnv });

  // Strip dev-only paths from the release index. readPublicExcludes always
  // includes .public-exclude itself, so even an empty exclusion list doesn't
  // reveal on the public remote that an exclusion list exists.
  const devOnlyPaths = readPublicExcludes(process.cwd());
  console.log(`\n→ Excluding ${devOnlyPaths.length} dev-only path(s) from the release commit...`);
  for (const p of devOnlyPaths) {
    // --cached         : index-only (belt and braces — the scratch index)
    // --ignore-unmatch : silently skip paths that aren't tracked
    // -r               : handle directory entries
    // --               : end-of-options guard for paths beginning with `-`
    spawnSync("git", ["rm", "--cached", "--ignore-unmatch", "-r", "-q", "--", p], {
      env: indexEnv,
      stdio: "inherit",
    });
  }

  const treeSha = git(["write-tree"], { env: indexEnv }).trim();

  // Verify the stripping actually happened before any object becomes
  // reachable from a ref: the release tree must not contain a single
  // excluded path. Counting here is what turns "eyeball the dry-run"
  // into an assertion.
  const treeFiles = git(["ls-tree", "-r", "--name-only", treeSha])
    .split("\n")
    .filter(Boolean);
  const leaked = treeFiles.filter(f =>
    devOnlyPaths.some(e => f === e || f.startsWith(e + "/"))
  );
  if (leaked.length > 0) {
    fail(
      [`Release tree still contains ${leaked.length} dev-only path(s):`, ...leaked.map(f => `  ${f}`)].join("\n")
    );
  }

  // ISO-8601 in UTC for both author and committer dates. Format Git expects
  // is "YYYY-MM-DDTHH:MM:SS +0000" (with explicit space + offset).
  const releaseDate = new Date().toISOString().replace(/\.\d{3}Z$/, " +0000");
  const releaseEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: PUBLIC_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: PUBLIC_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: PUBLIC_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: PUBLIC_AUTHOR_EMAIL,
    GIT_AUTHOR_DATE: releaseDate,
    GIT_COMMITTER_DATE: releaseDate,
  };

  // spawnSync + arg array so no shell ever interprets the message. Passing
  // it through a shell previously turned the subject/body separator into
  // literal `\n\n` characters, because neither bash nor cmd.exe expands
  // backslash escapes inside double quotes. Two -m flags is git's
  // documented "subject, blank line, body"; commit-tree takes the same.
  console.log(`\n→ Committing release ${version}${parentSha ? ` (child of ${parentSha.slice(0, 7)})` : " (root)"}...`);
  const subject = `Release ${version}`;
  const commitTreeArgv = ["commit-tree", treeSha];
  if (parentSha) commitTreeArgv.push("-p", parentSha);
  commitTreeArgv.push("-m", subject);
  if (summary) commitTreeArgv.push("-m", summary);
  const commitResult = spawnSync("git", commitTreeArgv, { encoding: "utf-8", env: releaseEnv });
  if (commitResult.status !== 0) {
    fail(`git commit-tree failed:\n${commitResult.stderr}`);
  }
  commitSha = commitResult.stdout.trim();
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}

if (!noTag) {
  console.log(`\n→ Tagging ${commitSha.slice(0, 7)} as ${tag}...`);
  const tagArgv = summary
    ? ["tag", "-a", tag, commitSha, "-m", tag, "-m", summary]
    : ["tag", "-a", tag, commitSha, "-m", tag];
  const releaseDateEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: PUBLIC_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: PUBLIC_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: PUBLIC_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: PUBLIC_AUTHOR_EMAIL,
    GIT_AUTHOR_DATE: git(["show", "-s", "--format=%aD", commitSha]).trim(),
    GIT_COMMITTER_DATE: git(["show", "-s", "--format=%cD", commitSha]).trim(),
  };
  const tagResult = spawnSync("git", tagArgv, { stdio: "inherit", env: releaseDateEnv });
  if (tagResult.status !== 0) process.exit(tagResult.status ?? 1);
}

console.log(`\n→ Release commit: ${commitSha}`);
console.log(git(["log", "-1", "--stat", "--format=fuller", commitSha]));

if (dryRun) {
  console.log(`──────────────────────────────────────────────────────────────`);
  console.log(`--dry-run: stopping before the push. Nothing was checked out,`);
  console.log(`no branch was created, and the working tree was never touched.`);
  console.log(``);
  console.log(`Inspect further:  git show --stat ${commitSha.slice(0, 12)}`);
  console.log(`Push manually:    git push ${PUBLIC_REMOTE} ${commitSha}:refs/heads/main${noTag ? "" : ` && git push ${PUBLIC_REMOTE} ${tag}`}`);
  if (!noTag) console.log(`Discard the tag:  git tag -d ${tag}`);
  console.log(`(The commit object itself is unreferenced${noTag ? "" : " once the tag is deleted"} and will be garbage-collected.)`);
  process.exit(0);
}

console.log(`→ Pushing ${commitSha.slice(0, 7)} → ${PUBLIC_REMOTE}/main${parentSha ? "" : " (creating root)"}...`);
console.log(`  (the pre-push hook runs the full scanner suite + fast-forward guard)`);
const pushArgs = ["push", PUBLIC_REMOTE, `${commitSha}:refs/heads/main`];
if (allowReroot) pushArgs.push("--force");
const push = spawnSync("git", pushArgs, { stdio: "inherit" });
if (push.status !== 0) process.exit(push.status ?? 1);

if (!noTag) {
  console.log(`\n→ Pushing tag ${tag} to ${PUBLIC_REMOTE}...`);
  const tagPush = spawnSync("git", ["push", PUBLIC_REMOTE, tag], { stdio: "inherit" });
  if (tagPush.status !== 0) process.exit(tagPush.status ?? 1);
}

console.log(`\n──────────────────────────────────────────────────────────────`);
console.log(`✓ Release ${version} published to ${PUBLIC_REMOTE}.`);
console.log(
  parentSha
    ? `  Public main:    fast-forwarded to ${commitSha.slice(0, 7)}`
    : `  Public main:    rooted at ${commitSha.slice(0, 7)}`
);
if (!noTag) console.log(`  Public tag:     ${tag}`);
console.log(`  Dev (${sourceBranch}):   untouched`);

// A pushed tag is not a GitHub Release, and Foundry fetches `module.zip` from
// a Release ASSET. Stopping here leaves a public branch nobody can install
// from, which looks like a finished release from every angle except the only
// one that matters.
console.log(``);
console.log(`  Not done yet — Foundry installs from a GitHub Release, not a tag:`);
console.log(`    1. npm run build`);
console.log(`    2. Create the Release on ${tag} and attach BOTH`);
console.log(`       dist-module/module.json and dist-module/module.zip`);
console.log(`    3. Register the version — see RELEASING.md`);
