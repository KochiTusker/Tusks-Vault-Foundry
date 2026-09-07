// Parse .public-exclude — the list of dev-only paths that live on origin
// (Tusks-Vault-Dev) but must never reach the public mirror. One place to
// parse it, three consumers: the release script (strips the paths from the
// release commit's index), the forbidden-filename layer in the secret
// scanner (blocks a public push that still contains them — i.e. a release
// build that forgot the stripping step), and the current-tree audit.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const PUBLIC_EXCLUDE_FILE = ".public-exclude";

/**
 * Read the exclusion list. Returns the listed paths PLUS the list file
 * itself — the file's existence on the public remote would reveal that an
 * exclusion list exists, so it is always also stripped.
 *
 * Paths are returned normalised to forward slashes with no trailing slash;
 * comments (#) and blank lines are ignored.
 */
export function readPublicExcludes(repoRoot) {
  const file = path.join(repoRoot, PUBLIC_EXCLUDE_FILE);
  const out = [PUBLIC_EXCLUDE_FILE];
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, "utf-8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    out.push(line.replace(/\\/g, "/").replace(/\/+$/, ""));
  }
  return out;
}

/**
 * True when `filePath` is covered by `exclude` — an exact match, or any
 * path inside an excluded directory.
 */
export function isPublicExcluded(filePath, exclude) {
  const p = String(filePath).replace(/\\/g, "/");
  return p === exclude || p.startsWith(exclude + "/");
}

/**
 * Findings for every file in `files` that a public-bound tree must not
 * contain. An empty result means the exclusion step ran (or there was
 * nothing to exclude).
 */
export function checkPublicExcluded(files, excludes) {
  const findings = [];
  for (const f of files) {
    const hit = excludes.find(e => isPublicExcluded(f, e));
    if (hit) {
      findings.push({
        layer: "filename",
        file: f,
        commit: "",
        detail: `(dev-only, listed via ${hit === PUBLIC_EXCLUDE_FILE ? "the exclusion mechanism" : `.public-exclude entry "${hit}"`}) — must be stripped before anything public-bound`,
      });
    }
  }
  return findings;
}
