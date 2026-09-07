import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BINARY_EXTENSIONS, TEXT_EXTENSIONS, isBinaryPath } from "./text-extensions.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Tracked files plus untracked-but-not-ignored ones — the same set
 *  audit-current-tree.mjs scans, so this test covers exactly what that
 *  scanner is responsible for. NUL-delimited and argv-form for the same
 *  reason it is there: filenames may contain anything. */
function listFiles(extraArgs) {
  return execFileSync("git", ["ls-files", "-z", ...extraArgs], {
    cwd: repoRoot,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

describe("no NUL bytes outside known-binary files", () => {
  // The gate this protects: scripts/audit-current-tree.mjs routes any file
  // containing a NUL byte to the binary-metadata layer and skips every
  // content layer — protected names, token shapes, emails, local paths,
  // fixture names, disclosure prose. For a PNG that is right. For a source
  // file it is an invisible hole, and it happened: a .ts carried raw 0x00 and
  // 0x1F bytes in a regex character class where `\x00`/`\x1f` escapes
  // belonged. It compiled, every test passed, and the scanner never read it.
  //
  // An allowlist, not a denylist. The failure being guarded against is a file
  // quietly leaving the scanner's reach, and a denylist only catches the
  // shapes someone already thought of.
  it("finds files to check (the guard is actually running)", () => {
    // A tripwire for the file list coming back empty — a `git ls-files` that
    // silently returns nothing would make the NUL-byte check below pass by
    // examining zero files. The threshold is deliberately well under this
    // repository's actual count (it is a module, not an application) so an
    // ordinary deletion does not fail the suite; it is checking for zero, not
    // policing the file count.
    const files = [...new Set([...listFiles([]), ...listFiles(["--others", "--exclude-standard"])])];
    expect(files.length).toBeGreaterThan(20);
  });

  it("no file outside the binary allowlist contains a NUL byte", () => {
    const files = [...new Set([...listFiles([]), ...listFiles(["--others", "--exclude-standard"])])];
    const offenders = [];

    for (const file of files) {
      if (isBinaryPath(file)) continue;
      const full = path.join(repoRoot, file);
      let buf;
      try {
        // Skip anything huge; a NUL in a 200 MB file is not what this catches
        // and reading it into memory per test run is not worth it.
        if (statSync(full).size > 5 * 1024 * 1024) continue;
        buf = readFileSync(full);
      } catch {
        continue; // listed but gone — nothing to read
      }
      const at = buf.indexOf(0);
      if (at !== -1) {
        offenders.push(`${file} (first NUL at byte ${at})`);
      }
    }

    expect(
      offenders,
      "These files contain NUL bytes, so audit-current-tree.mjs skips every content " +
        "layer on them. Either the file has a raw control byte that should be an escape " +
        "sequence, or its extension belongs in BINARY_EXTENSIONS."
    ).toEqual([]);
  });
});

describe("the two extension lists", () => {
  it("never classes the same extension as both text and binary", () => {
    const both = [...TEXT_EXTENSIONS].filter(ext => BINARY_EXTENSIONS.has(ext));
    expect(both).toEqual([]);
  });

  it("has every entry lowercase and dot-prefixed, since lookups normalise that way", () => {
    for (const ext of [...TEXT_EXTENSIONS, ...BINARY_EXTENSIONS]) {
      expect(ext, `${ext} should start with a dot`).toMatch(/^\./);
      expect(ext, `${ext} should be lowercase`).toBe(ext.toLowerCase());
    }
  });

  it("matches extensions case-insensitively", () => {
    expect(isBinaryPath("public/brand.PNG")).toBe(true);
    expect(isBinaryPath("public/brand.png")).toBe(true);
    expect(isBinaryPath("src/server/forge/schema.ts")).toBe(false);
  });

  it("treats an extensionless file as non-binary, so it still gets checked", () => {
    // scripts/hooks/pre-push and friends have no extension and are text.
    expect(isBinaryPath("scripts/hooks/pre-push")).toBe(false);
    expect(isBinaryPath("LICENSE")).toBe(false);
  });

  it("does not mistake a dotted directory for an extension", () => {
    expect(isBinaryPath("some.dir/pre-push")).toBe(false);
  });
});
