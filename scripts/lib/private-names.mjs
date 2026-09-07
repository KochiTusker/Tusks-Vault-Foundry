// Private-name denylist — the layer that scans for REAL PEOPLE by name.
//
// WHY THIS FILE CONTAINS NO NAMES
// ================================
// Every other scanner layer can hold its patterns in tracked source, because
// a regex for an API key is not itself an API key. That breaks down here: a
// denylist of the names you are trying to keep off the internet, committed to
// a repo, publishes them — and it publishes them in a file whose whole
// purpose announces that these are the names that matter.
//
// So the names live in `.private-names`, which is gitignored and never
// committed, and this file holds only the machinery. `.private-names.example`
// documents the format for anyone else who clones the repo.
//
// FAILURE MODE, AND THE ASYMMETRY THAT HANDLES IT
// ================================================
// A denylist that silently no-ops when its data file goes missing is worse
// than no denylist, because it reads as protection. But the file genuinely is
// absent for contributors, who must still be able to build and test. So:
//
//   - Tree audit / dev-side runs: absent list → loud warning, not a failure.
//   - Push to the public remote: absent list → HARD FAILURE. Only the
//     maintainer pushes there, and for the maintainer "the file vanished" is
//     never the intended state.
//
// Read `requireList` at each call site as "is this the last gate before
// bytes leave the machine?".

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const PRIVATE_NAMES_FILE = ".private-names";

/** Files that are allowed to mention a denylisted string: the list itself,
 *  and the file documenting the list's format. */
const SELF_REFERENTIAL = [/(^|\/)\.private-names$/, /(^|\/)\.private-names\.example$/];

/**
 * Read the denylist. Returns `{ names, present }`.
 *
 * Format: one entry per line, `#` for comments, blank lines ignored.
 * Entries are matched case-insensitively on word boundaries. An entry may
 * be any string worth protecting — a first name, an email local-part, a
 * home-folder name, a machine name.
 */
export function loadPrivateNames(repoRoot) {
  const file = path.join(repoRoot, PRIVATE_NAMES_FILE);
  if (!existsSync(file)) return { names: [], present: false };
  const names = readFileSync(file, "utf-8")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"));
  return { names, present: true };
}

/**
 * Resolve the list for a run.
 *
 * `requireList: true` (the public push path) throws when the file is
 * missing — an unverifiable state must never read as clean. Everywhere else
 * an absent list produces one loud warning finding and an empty name set.
 */
export function resolvePrivateNames(repoRoot, { requireList = false } = {}) {
  const { names, present } = loadPrivateNames(repoRoot);
  if (!present && requireList) {
    throw new Error(
      `${PRIVATE_NAMES_FILE} is missing. The private-name layer cannot run, and an ` +
        `unscanned push to the public remote is not a safe push. Create the file ` +
        `(one protected string per line — see ${PRIVATE_NAMES_FILE}.example) and retry.`
    );
  }
  const warnings = present
    ? []
    : [
        {
          layer: "private-name",
          file: PRIVATE_NAMES_FILE,
          commit: "",
          detail:
            "denylist file absent — the private-name layer is NOT running. Fine for a " +
            "contributor clone; for the maintainer, restore the file.",
        },
      ];
  return { names, present, warnings };
}

/** Build the word-boundary matcher for one entry. Escapes regex
 *  metacharacters so an entry like `j.doe` matches literally. */
function matcherFor(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, "i");
}

/**
 * Scan one file's content for denylisted strings.
 * Findings mask the matched entry — the report must not itself republish
 * the name it exists to protect.
 */
export function scanLinesForPrivateNames(file, content, names, commit = "") {
  if (names.length === 0) return [];
  const normalised = String(file).replace(/\\/g, "/");
  if (SELF_REFERENTIAL.some(re => re.test(normalised))) return [];
  const matchers = names.map(n => ({ name: n, re: matcherFor(n) }));
  const findings = [];
  const lines = String(content).split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const { name, re } of matchers) {
      if (re.test(line)) {
        findings.push({
          layer: "private-name",
          file,
          commit,
          detail: `line ${i + 1}: protected string "${name.slice(0, 2)}…" (${name.length} chars) appears here`,
        });
        break;
      }
    }
  });
  return findings;
}
