// Multi-layer scanner core, shared by the pre-push gate
// (audit-push-range.mjs), the current-tree audit (audit-current-tree.mjs)
// and the history audit (audit-history.mjs). One definition of what a
// finding is, one place each layer is invoked from.
//
// Layers (per file / per added diff line):
//   filename      — files that must never be tracked at all, and dev-only
//                   files that must never reach a public-bound tree
//
// Ported from Tusk's Vault, which runs the same suite over the same
// dev-to-public split. The layers are deliberately identical: a module that
// ships to strangers through Foundry's package registry has the same exposure
// as the app it bridges to, and a weaker gate here would be the way around the
// stronger one there.
//   regex         — token shapes from audit-patterns.mjs (the canonical list)
//   email         — personal emails            (personal-info-scanner.mjs)
//   path          — local paths with usernames (personal-info-scanner.mjs)
//   fixture-name  — name-shaped fixture values (personal-info-scanner.mjs)
//   private-name  — the maintainer's denylist  (private-names.mjs)
//   disclosure    — prose naming the defences  (disclosure-scanner.mjs)
//   identity      — commit author/committer    (public-bound ranges only)
//   gitleaks      — the ~150-rule second layer (optional binary)

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PATTERNS, maskMatch, shouldSuppress } from "../audit-patterns.mjs";
import { findGitleaks } from "../find-gitleaks.mjs";
import { readPublicExcludes, checkPublicExcluded, isPublicExcluded } from "./public-exclude.mjs";
import {
  scanLinesForEmails,
  scanLinesForLocalPaths,
  scanLinesForFixtureNames,
  checkCommitIdentities,
} from "./personal-info-scanner.mjs";
import { resolvePrivateNames, scanLinesForPrivateNames } from "./private-names.mjs";
import { scanLinesForDisclosure } from "./disclosure-scanner.mjs";

// ----- Layer: forbidden filenames -----
//
// Two categories with different modes:
//   credential shapes — blocking EVERYWHERE (dev CI included); these files
//     hold live secrets by construction and have no business being tracked.
//   dev-only paths — blocking only for a PUBLIC-BOUND tree; the dev repo
//     ships them deliberately. Every label carries the literal substring
//     "(dev-only" so --dev-mode can filter exactly these.
const CREDENTIAL_FILENAME_RES = [
  { re: /(^|\/)\.env(\.[^/]*)?$/, why: "environment file", allow: /\.example$/ },
  { re: /\.(pem|key|pfx|p12)$/i, why: "key material" },
  { re: /(^|\/)id_(rsa|ed25519|ecdsa)[^/]*$/, why: "SSH private key" },
  { re: /(^|\/)credentials\.json$/i, why: "credential store" },
  { re: /(^|\/)api-keys\.json$/, why: "a key store — runtime state, never tracked" },
  { re: /(^|\/)settings\.json$/, why: "runtime state, never tracked", allow: /(^|\/)\.(vscode|claude)\// },
  { re: /(^|\/)\.private-names$/, why: "the private-name denylist — publishing it defeats it" },
];

export function checkForbiddenFilenames(files, { publicBound = false, repoRoot = process.cwd() } = {}) {
  const findings = [];
  for (const f of files) {
    const p = String(f).replace(/\\/g, "/");
    for (const { re, why, allow } of CREDENTIAL_FILENAME_RES) {
      if (re.test(p) && !(allow && allow.test(p))) {
        findings.push({ layer: "filename", file: f, commit: "", detail: why });
        break;
      }
    }
  }
  if (publicBound) {
    findings.push(...checkPublicExcluded(files, readPublicExcludes(repoRoot)));
  }
  return findings;
}

// ----- Fixture exemptions, shared with gitleaks -----
//
// .gitleaks.toml's [allowlist].paths is the repo's one registry of files
// that hold INTENTIONAL synthetic secrets (test fixtures for the scrubber
// and the pattern suite). The token-shape layer honours the same list so a
// fixture doesn't need registering twice — CLAUDE.md already documents
// "new test file with fake keys → add it to .gitleaks.toml".
export function readTokenExemptions(repoRoot) {
  const toml = path.join(repoRoot, ".gitleaks.toml");
  if (!existsSync(toml)) return [];
  const src = readFileSync(toml, "utf-8");
  const res = [];
  // Triple-quoted TOML strings hold Go-style regexes; they compile as JS
  // regexes for the anchored-path shapes this file uses.
  for (const m of src.matchAll(/'''([^']+)'''/g)) {
    try {
      res.push(new RegExp(m[1]));
    } catch {
      /* a pattern only gitleaks can parse still protects the gitleaks layer */
    }
  }
  return res;
}

// ----- Layer: token shapes -----

export function scanLinesForTokens(file, content, commit = "") {
  const findings = [];
  const lines = String(content).split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        if (shouldSuppress(name, line)) continue;
        findings.push({
          layer: "regex",
          file,
          commit,
          detail: `line ${i + 1}: [${name}] ${maskMatch(m[0])}`,
        });
      }
    }
  });
  return findings;
}

// ----- Layer: gitleaks over a directory (working tree) -----

export function runGitleaksDir(dir) {
  const gitleaks = findGitleaks();
  if (!gitleaks) return { available: false, findings: [] };
  const result = spawnSync(gitleaks, ["dir", dir, "--redact", "--no-banner"], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === 0) return { available: true, findings: [] };
  return {
    available: true,
    findings: [
      {
        layer: "gitleaks",
        file: "",
        commit: "",
        detail: (result.stdout + result.stderr).trim().slice(0, 4000),
      },
    ],
  };
}

// ----- Content sweep: every per-line layer against one file -----

/**
 * Run every content layer over one file. `names` is the resolved private-name
 * list; pass [] to skip that layer (its warning is produced by the caller via
 * resolvePrivateNames). `fixtureExemptions` are the .gitleaks.toml allowlist
 * regexes — a file registered there is declared to hold synthetic
 * secret-SHAPED fixtures, so the shape-based layers (tokens, emails, paths)
 * skip it. The name layers still run on it: a real person's name in a
 * fixture is a leak regardless of what the fixture is for.
 */
export function scanFileContent(file, content, { commit = "", names = [], fixtureExemptions = [] } = {}) {
  const p = String(file).replace(/\\/g, "/");
  const shapeExempt = fixtureExemptions.some(re => re.test(p));
  return [
    ...(shapeExempt
      ? []
      : [
          ...scanLinesForTokens(file, content, commit),
          ...scanLinesForEmails(file, content, commit),
          ...scanLinesForLocalPaths(file, content, commit),
        ]),
    ...scanLinesForFixtureNames(file, content, commit),
    ...scanLinesForPrivateNames(file, content, names, commit),
    ...scanLinesForDisclosure(file, content, commit),
  ];
}

// ----- Range walk: every layer against the ADDED lines of a commit range -----

/**
 * Scan a git commit range (or a single sha's full ancestry) the way the
 * pre-push hook needs: added lines only — text being removed is the fix,
 * not the fault. `publicBound: true` additionally runs the filename layer
 * against the range's final file list, the identity check across the range,
 * and makes an absent private-name list a hard error instead of a warning.
 */
export function runAllChecks(range, { publicBound = false, repoRoot = process.cwd() } = {}) {
  const blocking = [];
  const warnings = [];

  // Private names: fail closed on the public path, warn elsewhere.
  const { names, warnings: nameWarnings } = resolvePrivateNames(repoRoot, {
    requireList: publicBound,
  });
  warnings.push(...nameWarnings);
  const fixtureExemptions = readTokenExemptions(repoRoot);
  // Public-excluded files never ship: their PRESENCE in a public tree is the
  // finding (filename layer, below); content findings on them are noise.
  const publicExcludes = readPublicExcludes(repoRoot);
  const isExcludedPath = f => publicExcludes.some(e => isPublicExcluded(f, e));

  // Walk the diff.
  let diff;
  const logArgs = ["log", "-p", "--no-color", "--format=commit %H"];
  try {
    diff = execFileSync("git", [...logArgs, range], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 500 * 1024 * 1024,
    });
  } catch {
    // Range endpoints missing locally (first push to a new remote) — scan
    // the local sha's full ancestry instead.
    const localSha = range.includes("..") ? range.split("..").pop() : range;
    diff = execFileSync("git", [...logArgs, localSha], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 500 * 1024 * 1024,
    });
  }

  let currentCommit = "";
  let currentFile = "";
  for (const dl of diff.split("\n")) {
    if (dl.startsWith("commit ")) {
      currentCommit = dl.slice(7, 14);
    } else if (dl.startsWith("+++ b/")) {
      currentFile = dl.slice(6);
    } else if (dl.startsWith("+") && !dl.startsWith("+++")) {
      if (isExcludedPath(currentFile)) continue;
      blocking.push(
        ...scanFileContent(currentFile, dl.slice(1), {
          commit: currentCommit,
          names,
          fixtureExemptions,
        })
      );
    }
  }

  if (publicBound) {
    // The tree the range's tip would publish must not contain dev-only or
    // credential-shaped files — this is the check that catches a release
    // build that forgot the exclusion step.
    const tip = range.includes("..") ? range.split("..").pop() : range;
    try {
      const files = execFileSync("git", ["ls-tree", "-r", "--name-only", tip], {
        cwd: repoRoot,
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
      })
        .split("\n")
        .filter(Boolean);
      blocking.push(...checkForbiddenFilenames(files, { publicBound: true, repoRoot }));
    } catch {
      warnings.push({
        layer: "filename",
        file: "",
        commit: "",
        detail: `could not list the tree at ${tip} — filename layer skipped for this range`,
      });
    }
    blocking.push(...checkCommitIdentities(repoRoot, { range }));
  }

  // Gitleaks over the same range (git mode), if available.
  const gitleaks = findGitleaks();
  let gitleaksAvailable = false;
  if (gitleaks) {
    gitleaksAvailable = true;
    const result = spawnSync(
      gitleaks,
      ["git", "--redact", "--no-banner", `--log-opts=${range}`],
      { cwd: repoRoot, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }
    );
    if (result.status !== 0) {
      blocking.push({
        layer: "gitleaks",
        file: "",
        commit: "",
        detail: (result.stdout + result.stderr).trim().slice(0, 4000),
      });
    }
  }

  return { blocking: dedupeFindings(blocking), warnings: dedupeFindings(warnings), gitleaksAvailable };
}

// ----- Reporting helpers -----

export function dedupeFindings(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const key = `${f.layer}|${f.commit}|${f.file}|${f.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

export const LAYER_LABELS = {
  filename: "Filename",
  regex: "Token-shape regex",
  gitleaks: "gitleaks (~150 rules)",
  identity: "Commit identity",
  email: "Personal email",
  path: "Local-filesystem path",
  "fixture-name": "Name-shaped fixture value",
  "private-name": "PROTECTED STRING",
  disclosure: "Tells a reader what is defended",
  binary: "Binary metadata",
  "fast-forward": "Breaks the in-app updater",
};

export function printFindings(findings, { stream = console.error } = {}) {
  const byLayer = new Map();
  for (const f of findings) {
    if (!byLayer.has(f.layer)) byLayer.set(f.layer, []);
    byLayer.get(f.layer).push(f);
  }
  for (const [layer, rows] of byLayer) {
    stream(`  [${LAYER_LABELS[layer] ?? layer}] — ${rows.length} finding(s):`);
    for (const f of rows.slice(0, 40)) {
      const where = [f.commit, f.file].filter(Boolean).join("  ");
      stream(`    ${where ? where + "  " : ""}${f.detail}`);
    }
    if (rows.length > 40) stream(`    …and ${rows.length - 40} more`);
    stream("");
  }
}
