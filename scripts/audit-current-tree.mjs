#!/usr/bin/env node
/**
 * Audit ONLY the current working tree — exactly the state the next release
 * commit would publish. Catches findings the next public release would
 * actually carry, ignoring anything that lived in dev history but has since
 * been removed.
 *
 * Usage:
 *   node scripts/audit-current-tree.mjs            — public-release mode
 *   node scripts/audit-current-tree.mjs --dev-mode — dev-CI mode (dev-only
 *     docs like CLAUDE.md are allowed to be present; everything else gates)
 *
 * Exit code:
 *   0 — clean, safe to build a release commit
 *   1 — at least one blocking finding in the current tree
 *   2 — not a git repo
 *
 * Companion to audit-history.mjs (which scans everything ever) and the
 * pre-push hook (which scans only the commits being pushed). Run the
 * default mode immediately before any release; run --dev-mode on every CI
 * build so credentials / identities / token shapes are caught before they
 * accumulate.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  checkForbiddenFilenames,
  scanFileContent,
  readTokenExemptions,
  dedupeFindings,
  printFindings,
} from "./lib/secret-scanner.mjs";
import { checkCommitIdentities } from "./lib/personal-info-scanner.mjs";
import { resolvePrivateNames } from "./lib/private-names.mjs";
import { readPublicExcludes, isPublicExcluded } from "./lib/public-exclude.mjs";
import { TEXT_EXTENSIONS } from "./lib/text-extensions.mjs";

const DEV_MODE = process.argv.includes("--dev-mode");

// Filename-layer findings to ignore under --dev-mode: these flags exist to
// block dev-only files from reaching a public tree, but the dev repo SHOULD
// ship them. The substring "(dev-only" appears in every dev-only label;
// matching on that keeps the credential-shaped filename hits (`.env`,
// `.pem`, `api-keys.json` etc.) blocking even in dev CI.
const DEV_MODE_FILENAME_FILTER = /\(dev-only/i;

let repoRoot;
try {
  repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  }).trim();
} catch {
  console.error("Not in a git repo.");
  process.exit(2);
}

console.log(`Auditing current working tree at ${path.basename(repoRoot)} (${DEV_MODE ? "dev" : "public-release"} mode)\n`);

// File list: tracked files PLUS untracked-but-not-ignored ones, NUL-delimited
// so newlines / quotes / shell metacharacters in filenames are handled, via
// argv-form execFileSync so a hostile filename can't extend a command line.
//
// Untracked files are included because this script's contract is "exactly
// what the next release commit would publish", and that commit stages new
// files as readily as modified ones. Scanning only tracked files would let a
// brand-new file carry anything at all and still report clean, right up
// until the moment it shipped.
function listFiles(extraArgs) {
  return execFileSync("git", ["ls-files", "-z", ...extraArgs], {
    cwd: repoRoot,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}
const files = [...new Set([...listFiles([]), ...listFiles(["--others", "--exclude-standard"])])];

const blocking = [];
const warnings = [];

// ── Layer: private-name denylist availability ────────────────────────────
// Warn-only here: a contributor clone legitimately lacks the file. The push
// gate is where absence hard-fails.
const { names, warnings: nameWarnings } = resolvePrivateNames(repoRoot, { requireList: false });
warnings.push(...nameWarnings);

// ── Layer: filenames (credential shapes always; dev-only paths in public mode) ──
blocking.push(...checkForbiddenFilenames(files, { publicBound: true, repoRoot }));

// ── Binary metadata (pure node — no exiftool dependency) ─────────────────
//
// PNG: the only chunks a clean asset needs before IDAT are structural.
// Anything text-shaped (tEXt/zTXt/iTXt), timestamps (tIME) or embedded EXIF
// (eXIf) is authoring-tool metadata — Photoshop/Affinity/Procreate inject
// Software/Author chunks on re-export.
// JPEG: APP1/Exif and APP13/Photoshop-IRB segments carry camera and author
// metadata. PDF: an /Author entry names a person.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHUNK_ALLOW = new Set(["IHDR", "PLTE", "IDAT", "IEND", "pHYs", "sRGB", "gAMA", "cHRM", "bKGD", "tRNS", "sBIT", "iCCP", "acTL", "fcTL", "fdAT"]);

function checkBinaryMetadata(file, buf) {
  const findings = [];
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) {
    let off = 8;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString("ascii", off + 4, off + 8);
      if (!PNG_CHUNK_ALLOW.has(type)) {
        findings.push({
          layer: "binary",
          file,
          commit: "",
          detail: `PNG carries a "${type}" chunk — authoring-tool metadata; strip before this ships`,
        });
      }
      if (type === "IEND") break;
      off += 12 + len;
    }
  } else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) {
    // JPEG — walk the segment markers before the scan data.
    let off = 2;
    while (off + 4 <= buf.length && buf[off] === 0xff) {
      const marker = buf[off + 1];
      if (marker === 0xda) break; // start of scan — no more metadata segments
      const len = buf.readUInt16BE(off + 2);
      if (marker === 0xe1 || marker === 0xed) {
        const head = buf.toString("ascii", off + 4, Math.min(off + 24, buf.length));
        const kind = head.startsWith("Exif")
          ? "EXIF"
          : head.includes("ns.adobe.com")
            ? "XMP"
            : marker === 0xed
              ? "Photoshop IRB"
              : "APP1";
        findings.push({
          layer: "binary",
          file,
          commit: "",
          detail: `JPEG carries a ${kind} segment — camera/author metadata; strip before this ships`,
        });
      }
      off += 2 + len;
    }
  } else if (buf.subarray(0, 5).toString("ascii") === "%PDF-") {
    const text = buf.toString("latin1");
    if (/\/Author\s*\(/.test(text) || /\/Author\s*</.test(text)) {
      findings.push({
        layer: "binary",
        file,
        commit: "",
        detail: "PDF has an /Author entry in its info dictionary — verify it names nobody",
      });
    }
  }
  return findings;
}

// ── Layers: per-file content + binary metadata ───────────────────────────
const fixtureExemptions = readTokenExemptions(repoRoot);
const publicExcludes = readPublicExcludes(repoRoot);
const MAX_SCAN_BYTES = 5 * 1024 * 1024;

for (const file of files) {
  // Public-excluded files never ship; their presence is already the filename
  // layer's finding, so content findings on them would be pure noise.
  if (publicExcludes.some(e => isPublicExcluded(file, e))) continue;

  const full = path.join(repoRoot, file);
  let buf;
  try {
    if (statSync(full).size > MAX_SCAN_BYTES) {
      warnings.push({
        layer: "binary",
        file,
        commit: "",
        detail: `larger than ${MAX_SCAN_BYTES / 1024 / 1024} MB — skipped by the content layers; review by hand`,
      });
      continue;
    }
    buf = readFileSync(full);
  } catch {
    continue; // deleted-but-still-listed; nothing to scan
  }

  if (buf.includes(0)) {
    warnings.push(...checkBinaryMetadata(file, buf));
    // A NUL byte routes a file here and PAST every content layer — protected
    // names, token shapes, emails, local paths, fixture names, disclosure
    // prose. For a PNG that is correct. For a file whose extension says text
    // it is a hole in the gate, and until now a silent one: unlike the
    // over-size branch above, nothing was reported at all, so the audit's
    // "clean" verdict covered a file it had never read.
    //
    // Found in the wild: a .ts whose regex character class held raw 0x00 and
    // 0x1F bytes where `\x00`/`\x1f` escapes belonged. It compiled, it
    // passed every test, and it was invisible to this scanner.
    if (TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      warnings.push({
        layer: "binary",
        file,
        commit: "",
        detail:
          "text-extension file contains NUL bytes, so every content layer skipped it — " +
          "check for a raw control byte that should be an escape sequence, then re-run",
      });
    }
    continue;
  }

  blocking.push(...scanFileContent(file, buf.toString("utf-8"), { names, fixtureExemptions }));
}

// ── Layer: commit identities across ALL refs ─────────────────────────────
// The repo policy is a single pinned identity everywhere — dev commits
// included, because the dev remote is second-line defence, not a free pass.
blocking.push(...checkCommitIdentities(repoRoot, { allRefs: true }));

// ── Verdict ──────────────────────────────────────────────────────────────

let effectiveBlocking = dedupeFindings(blocking);
// Dev-only paths PRESENT in the working tree are expected in both modes —
// the dev repo ships them, and the release script strips them from its
// commit automatically. In dev mode they're pure noise (drop); in public
// mode they're worth a reminder (warn) so the dry-run inspection knows what
// to look for. What stays BLOCKING is a dev-only path inside a tree that is
// actually being pushed — the pre-push gate's ls-tree check owns that case.
const devOnly = effectiveBlocking.filter(
  f => f.layer === "filename" && DEV_MODE_FILENAME_FILTER.test(f.detail)
);
effectiveBlocking = effectiveBlocking.filter(f => !devOnly.includes(f));
if (!DEV_MODE) {
  warnings.push(
    ...devOnly.map(f => ({
      ...f,
      detail: f.detail + " (the release script strips this automatically — confirm in the dry-run output)",
    }))
  );
}
const effectiveWarnings = dedupeFindings(warnings);

if (effectiveWarnings.length > 0) {
  console.log(`⚠  ${effectiveWarnings.length} warning(s) — review, not blocking:\n`);
  printFindings(effectiveWarnings, { stream: console.log });
}

if (effectiveBlocking.length === 0) {
  console.log(`✓ Clean: ${files.length} file(s) scanned, no blocking findings.`);
  process.exit(0);
}

console.error(`✗ ${effectiveBlocking.length} BLOCKING finding(s):\n`);
printFindings(effectiveBlocking);
console.error(
  DEV_MODE
    ? "Fix the findings above before merging."
    : "A release built from this tree would publish the findings above. Fix them (or move genuinely dev-only files into .public-exclude) before releasing."
);
process.exit(1);
