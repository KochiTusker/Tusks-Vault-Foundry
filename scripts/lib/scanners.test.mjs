// Suite for the scanner library under scripts/lib/. Pure-function layers are
// tested directly; the file-reading layers get a temp directory. Synthetic
// secrets in here are registered in .gitleaks.toml's allowlist, which also
// exempts this file from the token layer (one registry, two consumers).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readPublicExcludes, isPublicExcluded, checkPublicExcluded } from "./public-exclude.mjs";
import { loadPrivateNames, resolvePrivateNames, scanLinesForPrivateNames } from "./private-names.mjs";
import {
  isAllowedEmail,
  scanLinesForEmails,
  scanLinesForLocalPaths,
  scanLinesForFixtureNames,
  readPinnedIdentity,
} from "./personal-info-scanner.mjs";
import { scanLinesForDisclosure } from "./disclosure-scanner.mjs";
import {
  checkForbiddenFilenames,
  scanLinesForTokens,
  scanFileContent,
  readTokenExemptions,
  dedupeFindings,
} from "./secret-scanner.mjs";

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "vault-scan-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ─── public-exclude ────────────────────────────────────────────────────────

describe("public-exclude", () => {
  it("always includes the list file itself, even when absent", () => {
    expect(readPublicExcludes(tmp)).toEqual([".public-exclude"]);
  });

  it("parses entries, skipping comments and blanks, normalising slashes", () => {
    writeFileSync(path.join(tmp, ".public-exclude"), "# comment\n\nCLAUDE.md\ndocs/dev/\n");
    expect(readPublicExcludes(tmp)).toEqual([".public-exclude", "CLAUDE.md", "docs/dev"]);
  });

  it("directory entries cover everything beneath them", () => {
    expect(isPublicExcluded("docs/dev/PLAN.md", "docs/dev")).toBe(true);
    expect(isPublicExcluded("docs/dev", "docs/dev")).toBe(true);
    expect(isPublicExcluded("docs/development.md", "docs/dev")).toBe(false);
  });

  it("checkPublicExcluded labels findings with the dev-only marker the filters key on", () => {
    const findings = checkPublicExcluded(["CLAUDE.md", "README.md"], ["CLAUDE.md"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain("(dev-only");
  });
});

// ─── private-names ─────────────────────────────────────────────────────────

describe("private-names", () => {
  it("absent list: loads empty, resolve warns, requireList throws", () => {
    expect(loadPrivateNames(tmp)).toEqual({ names: [], present: false });
    const resolved = resolvePrivateNames(tmp);
    expect(resolved.names).toEqual([]);
    expect(resolved.warnings).toHaveLength(1);
    expect(() => resolvePrivateNames(tmp, { requireList: true })).toThrow(/missing/);
  });

  it("present list: parses entries, no warning", () => {
    writeFileSync(path.join(tmp, ".private-names"), "# people\nJordan\nJORDANS-DESKTOP\n\n");
    const resolved = resolvePrivateNames(tmp, { requireList: true });
    expect(resolved.names).toEqual(["Jordan", "JORDANS-DESKTOP"]);
    expect(resolved.warnings).toEqual([]);
  });

  it("matches case-insensitively on word boundaries only", () => {
    const names = ["Jordan"];
    expect(scanLinesForPrivateNames("a.md", "written by jordan yesterday", names)).toHaveLength(1);
    expect(scanLinesForPrivateNames("a.md", "the jordanian border", names)).toHaveLength(0);
    expect(scanLinesForPrivateNames("a.md", "JORDAN: hello", names)).toHaveLength(1);
  });

  it("the finding masks the protected string instead of repeating it", () => {
    const [f] = scanLinesForPrivateNames("a.md", "ask Jordan", ["Jordan"]);
    expect(f.detail).not.toContain("Jordan");
    expect(f.detail).toContain("Jo…");
  });

  it("the list file and its example doc are self-exempt", () => {
    expect(scanLinesForPrivateNames(".private-names", "Jordan", ["Jordan"])).toHaveLength(0);
    expect(scanLinesForPrivateNames(".private-names.example", "#Jordan", ["Jordan"])).toHaveLength(0);
  });
});

// ─── personal-info: emails ─────────────────────────────────────────────────

describe("email layer", () => {
  it("flags a personal email, allows the public-alias forms", () => {
    expect(isAllowedEmail("12345+SomeUser@users.noreply.github.com")).toBe(true);
    expect(isAllowedEmail("git@github.com")).toBe(true);
    expect(isAllowedEmail("someone@example.com")).toBe(true);
    expect(isAllowedEmail("real.person@gmail.com")).toBe(false);
    const findings = scanLinesForEmails("doc.md", "contact real.person@gmail.com please");
    expect(findings).toHaveLength(1);
  });

  it("mutes lockfiles — dependency author metadata is pure noise there", () => {
    expect(scanLinesForEmails("package-lock.json", "x@y.com")).toHaveLength(0);
  });

  it("does not flag package import specifiers", () => {
    expect(scanLinesForEmails("a.ts", 'import x from "@vitejs/plugin-react"')).toHaveLength(0);
  });
});

// ─── personal-info: local paths ────────────────────────────────────────────

describe("local-path layer", () => {
  it("flags Windows and POSIX home paths with real-looking usernames", () => {
    expect(scanLinesForLocalPaths("a.md", "C:\\Users\\jsmith\\code")).toHaveLength(1);
    expect(scanLinesForLocalPaths("a.md", "/home/jsmith/code")).toHaveLength(1);
    expect(scanLinesForLocalPaths("a.md", "/Users/jsmith/code")).toHaveLength(1);
  });

  it("matches the JS-source-escaped doubled-backslash form too", () => {
    // A single-backslash regex misses this shape, and it is the shape that
    // actually appears inside tracked script string literals.
    expect(scanLinesForLocalPaths("a.mjs", 'const p = "C:\\\\Users\\\\jsmith\\\\x";')).toHaveLength(1);
  });

  it("allows documentation placeholders", () => {
    expect(scanLinesForLocalPaths("a.md", "C:\\Users\\<you>\\code")).toHaveLength(0);
    expect(scanLinesForLocalPaths("a.md", "/home/${USER}/code")).toHaveLength(0);
    expect(scanLinesForLocalPaths("a.md", "/Users/your-name/code")).toHaveLength(0);
  });
});

// ─── personal-info: fixture names ──────────────────────────────────────────

describe("fixture-name layer", () => {
  it("flags a name-shaped value in a fixture file only", () => {
    // Assembled at runtime so the tree audit's static scan of THIS file
    // doesn't flag its own test fixture.
    const line = `const playerName = "${"Rebe" + "cca"}";`;
    expect(scanLinesForFixtureNames("src/x.test.ts", line)).toHaveLength(1);
    expect(scanLinesForFixtureNames("src/x.ts", line)).toHaveLength(0);
  });

  it("allows the obvious synthetic values", () => {
    expect(scanLinesForFixtureNames("x.test.ts", 'const userName = "Test";')).toHaveLength(0);
    expect(scanLinesForFixtureNames("x.test.ts", 'const dmName = "Tusk";')).toHaveLength(0);
  });
});

// ─── personal-info: pinned identity ────────────────────────────────────────

describe("readPinnedIdentity", () => {
  it("reads the constants from the real release script", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..", "..");
    const id = readPinnedIdentity(repoRoot);
    expect(id.name).toBe("KochiTusker");
    expect(id.email).toMatch(/@users\.noreply\.github\.com$/);
  });

  it("throws when the trust root is unreadable — never defaults", () => {
    mkdirSync(path.join(tmp, "scripts"), { recursive: true });
    writeFileSync(path.join(tmp, "scripts", "release-to-public.mjs"), "// no constants here");
    expect(() => readPinnedIdentity(tmp)).toThrow(/trust root/);
  });
});

// ─── disclosure ────────────────────────────────────────────────────────────

describe("disclosure layer", () => {
  it("flags leak archaeology — a version tied to what it exposed", () => {
    expect(scanLinesForDisclosure("notes.md", "v1.3.0 shipped several real first names")).toHaveLength(1);
    expect(scanLinesForDisclosure("notes.md", "110 occurrences of names were found")).toHaveLength(1);
  });

  it("flags announced concealment", () => {
    expect(
      scanLinesForDisclosure("a.md", "dates are UTC so the timezone cannot reveal a location")
    ).toHaveLength(1);
  });

  it("stays quiet on ordinary user-protective security prose", () => {
    expect(scanLinesForDisclosure("a.md", "the server binds to loopback by default")).toHaveLength(0);
    expect(scanLinesForDisclosure("a.md", "keys are encrypted at rest with AES-256-GCM")).toHaveLength(0);
    expect(scanLinesForDisclosure("a.md", "logs are scrubbed before display")).toHaveLength(0);
  });

  it("reporter anonymity in SECURITY.md is exempt; the same line elsewhere fires", () => {
    const line = "reporters may remain anonymous; the maintainer's pseudonym protects the project";
    expect(scanLinesForDisclosure("SECURITY.md", line)).toHaveLength(0);
    expect(scanLinesForDisclosure("docs/notes.md", line)).toHaveLength(1);
  });
});

// ─── secret-scanner core ───────────────────────────────────────────────────

describe("checkForbiddenFilenames", () => {
  it("blocks credential-shaped files everywhere", () => {
    const findings = checkForbiddenFilenames([
      ".env.local",
      "certs/server.pem",
      "api-keys.json",
      "settings.json",
      ".private-names",
    ]);
    expect(findings).toHaveLength(5);
  });

  it("allows the documented exceptions", () => {
    expect(checkForbiddenFilenames([".env.example", ".vscode/settings.json"])).toHaveLength(0);
  });

  it("adds public-exclude findings only when publicBound", () => {
    writeFileSync(path.join(tmp, ".public-exclude"), "CLAUDE.md\n");
    expect(checkForbiddenFilenames(["CLAUDE.md"], { repoRoot: tmp })).toHaveLength(0);
    expect(checkForbiddenFilenames(["CLAUDE.md"], { publicBound: true, repoRoot: tmp })).toHaveLength(1);
  });
});

describe("scanLinesForTokens", () => {
  it("finds a token shape and reports it masked", () => {
    const findings = scanLinesForTokens("config.ts", 'key = "sk-ant-api03-AbCdEf1234567890ABCDEFghijkl_-"');
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain("Anthropic");
    expect(findings[0].detail).not.toContain("AbCdEf1234567890");
  });

  it("suppresses the OpenAI pattern on Anthropic-key lines", () => {
    const findings = scanLinesForTokens("a.ts", 'k="sk-ant-api03-AbCdEf1234567890ABCDEFghijkl_-"');
    expect(findings.filter(f => f.detail.includes("OpenAI"))).toHaveLength(0);
  });
});

describe("scanFileContent + fixture exemptions", () => {
  it("skips the shape layers for gitleaks-allowlisted fixtures but keeps the name layers", () => {
    const exemptions = [/^scripts\/lib\/scanners\.test\.mjs$/];
    const content = 'sk-ant-api03-AbCdEf1234567890ABCDEFghijkl_- and real.person@gmail.com';
    const exempt = scanFileContent("scripts/lib/scanners.test.mjs", content, {
      fixtureExemptions: exemptions,
      names: ["Rebecca"],
    });
    expect(exempt.filter(f => f.layer === "regex")).toHaveLength(0);
    expect(exempt.filter(f => f.layer === "email")).toHaveLength(0);
    // A protected string is still caught in an exempt fixture file.
    const withName = scanFileContent("scripts/lib/scanners.test.mjs", "by Rebecca", {
      fixtureExemptions: exemptions,
      names: ["Rebecca"],
    });
    expect(withName.filter(f => f.layer === "private-name")).toHaveLength(1);
    const notExempt = scanFileContent("src/other.ts", content, { fixtureExemptions: exemptions });
    expect(notExempt.filter(f => f.layer === "regex")).toHaveLength(1);
    expect(notExempt.filter(f => f.layer === "email")).toHaveLength(1);
  });

  it("reads the real .gitleaks.toml allowlist into usable regexes", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..", "..");
    const res = readTokenExemptions(repoRoot);
    expect(res.length).toBeGreaterThan(3);
    expect(res.some(re => re.test("scripts/audit-patterns.test.mjs"))).toBe(true);
  });
});

describe("dedupeFindings", () => {
  it("collapses identical findings, keeps distinct ones", () => {
    const f = { layer: "regex", file: "a", commit: "", detail: "x" };
    expect(dedupeFindings([f, { ...f }, { ...f, detail: "y" }])).toHaveLength(2);
  });
});
