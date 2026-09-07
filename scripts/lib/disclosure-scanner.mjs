// Disclosure layer: prose that tells a reader about the project's defences
// rather than about its code.
//
// Every other layer in this suite asks "is a secret present?". This one asks
// a different question: "does this text tell someone there is a secret worth
// looking for, and roughly where?" A comment naming a version that shipped
// something, a count of what leaked, or a note explaining that a timestamp is
// normalised so a timezone cannot be inferred, contains no secret at all. It
// is a search query.
//
// Round the patterns tight. A layer that fires on ordinary security
// commentary gets switched off, and then it protects nothing — this codebase
// legitimately discusses loopback binding, key handling and log redaction,
// because those are features that protect the USER and are worth documenting.
// What is caught here is narrower: the AUTHOR protecting THEMSELVES, said
// out loud.

/** Patterns, each with why it matters. Ordered most to least severe. */
const PATTERNS = [
  // Leak archaeology. The worst of the set: names a release, a count, or a
  // file class, which narrows a history search from "everything" to "this".
  {
    re: /\bv?\d+\.\d+\.\d+\b[^.\n]{0,60}\b(shipped|leaked|contained|exposed|carried)\b/i,
    why: "ties a version number to something that leaked",
  },
  {
    re: /\b(shipped|leaked|exposed)\b[^.\n]{0,40}\b(real|actual)\s+(first\s+)?names?\b/i,
    why: "states that real names were published",
  },
  {
    re: /\b\d{1,4}\s+occurrences?\b[^.\n]{0,40}\bnames?\b/i,
    why: "counts how many were exposed",
  },
  {
    re: /\bused to (carry|contain|hold)\b[^.\n]{0,50}\b(name|player|personal|private|real)\b/i,
    why: "says what a file used to contain",
  },

  // Concealment announced. Harmless to do; harmful to explain.
  {
    re: /\b(so|because)\b[^.\n]{0,40}\b(timezone|time zone|geolocation|location)\b[^.\n]{0,30}\b(leak|reveal|infer|give away|tell)\w*/i,
    why: "explains that a timestamp is normalised to hide a location",
  },
  {
    re: /\b(hide|hides|hiding|mask|masks|obscure|obscures|camouflage)\b[^.\n]{0,50}\b(identity|name|author|maintainer|location|timezone)\b/i,
    why: "describes masking the author",
  },
  {
    // Anonymity is only a signal when it is the AUTHOR'S. Offering a security
    // reporter the choice to stay anonymous is ordinary disclosure practice
    // and appears in every SECURITY.md worth having — so the phrase must sit
    // next to a word naming the project or its author before it fires.
    re: /\b(privacy stance|name-free)\b|\b(anonymit(y|ies)|anonymous|cannot be traced|can't be traced|pseudonym\w*)\b[^.\n]{0,40}\b(author|maintainer|owner|identity|project|branding|handle)\b|\b(author|maintainer|owner|identity|project|branding|handle)\b[^.\n]{0,40}\b(anonymit(y|ies)|anonymous|cannot be traced|can't be traced|pseudonym\w*)\b/i,
    why: "announces a deliberate anonymity posture",
  },
  {
    re: /\bso (that )?(nobody|no one|a reader|an attacker)\b[^.\n]{0,40}\b(can tell|knows|finds|works out)\b/i,
    why: "explains what the reader is meant not to learn",
  },

  // The defences themselves, named.
  {
    re: /\b(denylist|deny-list|private[- ]names|canar(y|ies)|osint[- ]canar)\w*\b/i,
    why: "names the name-protection tooling",
  },
  {
    re: /\b(pre-push (hook|gate)|push gate|release gate|secret scanner|OSINT)\b/i,
    why: "names the release gate",
  },
  {
    // Narrow on purpose: the dev remote's EXISTENCE is an accepted, documented
    // exposure (the dev-mode updater references it by name in shipped source).
    // What must not ship is prose pairing the dev repo with its access
    // control or credentials.
    re: /\b(dev|private) repo(sitory)?\b[^.\n]{0,30}\b(credentials?|token|secret|password)\b/i,
    why: "pairs the private counterpart repository with its access control",
  },
];

/** Files that legitimately discuss security because it protects the USER,
 *  plus the scanner suite itself (whose comments necessarily name what each
 *  layer defends — that is what makes the code maintainable, and the suite
 *  is dev-visible context, not a secret). */
const EXEMPT_FILE = /^(SECURITY\.md|docs\/Privacy\.md|scripts\/(audit-[a-z-]+|find-gitleaks|release-to-public|verify-parity|hooks\/pre-push|install-hooks|lib\/[a-z-]+)(\.test)?(\.mjs)?|\.gitleaks\.toml|\.gitignore|\.public-exclude|\.private-names\.example|\.github\/workflows\/[a-z-]+\.yml)$/;

/**
 * Scan one file's content.
 * @returns findings shaped like every other layer in this suite.
 */
export function scanLinesForDisclosure(file, content, commit = "") {
  if (EXEMPT_FILE.test(String(file).replace(/\\/g, "/"))) return [];
  const findings = [];
  const lines = String(content).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.length > 400) return;
    for (const { re, why } of PATTERNS) {
      if (re.test(line)) {
        findings.push({
          layer: "disclosure",
          file,
          commit,
          detail: `line ${i + 1}: ${why} — "${line.trim().slice(0, 90)}"`,
        });
        break;
      }
    }
  });
  return findings;
}
