// Personal-info scanner — the identity layers of the public-remote gate.
// Catches what the secret-shape regex and gitleaks structurally can't:
//
//   - Email addresses outside the public-alias allowlist (a real personal
//     email accidentally committed to docs, comments, fixtures).
//   - Local filesystem paths that embed a real username (a stray
//     `/Users/<actualname>/` or `<drive>:\Users\<actualname>\` in a script
//     or a captured log).
//   - Commit authors / committers other than the pinned public alias.
//   - Name-shaped strings in test-fixture files (a fixture derived from
//     real campaign data is exactly how such names ship).
//
// Placeholder forms (`<you>`, `<your-name>`, `${HOME}`, `/path/to/repo`)
// are allowlisted explicitly because they're documentation patterns.

import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// ----- Pinned public identity -----
//
// Read from scripts/release-to-public.mjs rather than duplicated here — two
// copies of a trust root drift. The release script executes argv parsing at
// import time, so it can't be imported as a module; the constants are read
// from its source instead, and a failed read throws rather than defaulting.
// An identity check that can't establish the expected identity must not run
// as though it did.
export function readPinnedIdentity(repoRoot) {
  const src = readFileSync(path.join(repoRoot, "scripts", "release-to-public.mjs"), "utf-8");
  const name = src.match(/PUBLIC_AUTHOR_NAME\s*=\s*"([^"]+)"/)?.[1];
  const email = src.match(/PUBLIC_AUTHOR_EMAIL\s*=\s*"([^"]+)"/)?.[1];
  if (!name || !email) {
    throw new Error(
      "Could not read PUBLIC_AUTHOR_NAME / PUBLIC_AUTHOR_EMAIL from " +
        "scripts/release-to-public.mjs — the identity layer has no trust root to check against."
    );
  }
  return { name, email };
}

// ----- Email allowlist -----
//
// The GitHub noreply form is the ONLY email shape allowed in tracked files
// and commit metadata. RFC-2606 example domains pass too — documentation
// needs example addresses.
const ALLOWED_EMAIL_PATTERNS = [
  /@users\.noreply\.github\.com$/i,
  /@example\.(com|org|net)$/i,
  /@example$/i,
  // GitHub's own infrastructure addresses — the SSH remote user and the
  // web-flow committer identity. Neither names a person.
  /^git@github\.com$/i,
  /^noreply@github\.com$/i,
];

// Dependency lockfiles carry author metadata for every package — the email
// layer is pure noise there. The token regex and gitleaks still scan them.
const EMAIL_SCAN_FILE_DENYLIST = [/(^|\/)package-lock\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.yaml$/];

// The TLD accepts any 2–24-char alphabetic suffix so `.ch`, `.tech`,
// `.cloud` and future gTLDs don't quietly slip through. Package import
// specifiers (`@vitejs/plugin-react`, `@/components`) don't match because
// there's no `.<letters>` directly after the host chars.
const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24}\b/g;

export function isAllowedEmail(email) {
  return ALLOWED_EMAIL_PATTERNS.some(re => re.test(email));
}

export function scanLinesForEmails(file, content, commit = "") {
  const normalised = String(file).replace(/\\/g, "/");
  if (EMAIL_SCAN_FILE_DENYLIST.some(re => re.test(normalised))) return [];
  const findings = [];
  const lines = String(content).split(/\r?\n/);
  lines.forEach((line, i) => {
    EMAIL_RE.lastIndex = 0;
    let m;
    while ((m = EMAIL_RE.exec(line)) !== null) {
      if (isAllowedEmail(m[0])) continue;
      findings.push({
        layer: "email",
        file,
        commit,
        detail: `line ${i + 1}: email outside the public-alias allowlist — "${m[0]}"`,
      });
    }
  });
  return findings;
}

// ----- Local filesystem paths -----
//
// Backslashes use `\\+` (one or more) so we match BOTH the raw-bytes form
// and the JS-source-escaped doubled-backslash form that appears in tracked
// .mjs / .ts string literals — a single-backslash regex misses the doubled
// form, which is the form scripts actually contain.
const PATH_PATTERNS = [
  { re: /[A-Za-z]:\\+Users\\+([^\\/\s"'`<>|]+)/g, what: "Windows user-profile path" },
  { re: /\/(?:home|Users)\/([^/\s"'`<>|]+)/g, what: "POSIX home-directory path" },
];

// Documentation placeholders that must keep working: `<you>`,
// `<your-name>`, `${USER}`, `%USERNAME%`, `your-name`, `username`, `name`.
const PLACEHOLDER_RE = /^(<[^>]+>|\$\{[A-Z_]+\}|\$[A-Z_]+|%[A-Z_]+%|you|your-?name|user(name)?|name)$/i;

export function scanLinesForLocalPaths(file, content, commit = "") {
  const findings = [];
  const lines = String(content).split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const { re, what } of PATH_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const username = m[1];
        if (PLACEHOLDER_RE.test(username)) continue;
        findings.push({
          layer: "path",
          file,
          commit,
          detail: `line ${i + 1}: ${what} embedding a username — "${m[0].slice(0, 60)}"`,
        });
      }
    }
  });
  return findings;
}

// ----- Commit identities -----

/**
 * Every author AND committer in `range` (or across all refs) must be the
 * pinned public identity. Anything else means local git config drifted —
 * and a drifted identity on a public-bound commit is a direct deanonymiser.
 */
export function checkCommitIdentities(repoRoot, { range = null, allRefs = false } = {}) {
  const pinned = readPinnedIdentity(repoRoot);
  const args = ["log", "--format=%H %an <%ae> | %cn <%ce>"];
  if (allRefs) args.push("--all");
  if (range) args.push(range);
  let out;
  try {
    out = execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  const findings = [];
  const expected = `${pinned.name} <${pinned.email}>`;
  // GitHub stamps itself as committer on web-UI commits (merges, file edits
  // made on github.com). That identity is GitHub's, reveals nothing about a
  // person, and appears on any repo whose maintainer ever clicked "Merge".
  // Authors must still be the pinned identity.
  const WEB_FLOW_COMMITTER = "GitHub <noreply@github.com>";
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const sp = line.indexOf(" ");
    const sha = line.slice(0, sp);
    const rest = line.slice(sp + 1);
    const [author, committer] = rest.split(" | ");
    for (const [role, id] of [["author", author], ["committer", committer]]) {
      if (role === "committer" && id === WEB_FLOW_COMMITTER) continue;
      if (id !== expected) {
        findings.push({
          layer: "identity",
          file: "",
          commit: sha.slice(0, 7),
          detail: `${role} is "${id}" — expected the pinned public identity "${expected}"`,
        });
      }
    }
  }
  return findings;
}

// ----- Name-shaped strings in fixtures -----
//
// Vault has no transcript speaker tags (that's the sibling project's leak
// shape); its equivalent risk is a test fixture derived from real campaign
// data. This layer flags Capitalised-word "name:"-style assignments inside
// fixture/test files ONLY, so the denylist layer doesn't have to know a name
// in advance to catch it. Deliberately narrow: firing on ordinary prose
// would get the layer switched off, and then it protects nothing.
const FIXTURE_FILE_RE = /(fixture|\.test\.|\.spec\.|__mocks__|testdata)/i;
// Key matching is case-insensitive (playerName / player_name / PLAYER_NAME);
// whether the VALUE is name-shaped (Capitalised word) is checked in code,
// because a regex can't be case-insensitive about one half only.
const NAME_ASSIGN_RE = /\b(?:player|user|author|speaker|dm|gm)[_ ]?name\s*[:=]\s*["'`]([A-Za-z]{3,21})["'`]/gi;

// Obvious non-person values fixtures legitimately use.
const NAME_VALUE_ALLOW_RE = /^(Test|Example|Sample|Dummy|Mock|Fake|Player|User|Name|Unknown|Anonymous|Tusk)$/;

export function scanLinesForFixtureNames(file, content, commit = "") {
  const normalised = String(file).replace(/\\/g, "/");
  if (!FIXTURE_FILE_RE.test(normalised)) return [];
  const findings = [];
  const lines = String(content).split(/\r?\n/);
  lines.forEach((line, i) => {
    NAME_ASSIGN_RE.lastIndex = 0;
    let m;
    while ((m = NAME_ASSIGN_RE.exec(line)) !== null) {
      if (!/^[A-Z][a-z]+$/.test(m[1])) continue; // not name-shaped
      if (NAME_VALUE_ALLOW_RE.test(m[1])) continue;
      findings.push({
        layer: "fixture-name",
        file,
        commit,
        detail: `line ${i + 1}: name-shaped fixture value "${m[1]}" — verify this is invented, not a real person (real names go in .private-names, and the fixture gets a synthetic one)`,
      });
    }
  });
  return findings;
}
