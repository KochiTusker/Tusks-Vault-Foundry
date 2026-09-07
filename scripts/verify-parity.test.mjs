// Pins `npm run verify`, the pre-push hook and CI to one definition of "the
// gates". The hook and CI drifting apart is not hypothetical: a hook that
// runs a strict subset of CI goes green locally and red remotely on
// failures nothing local could have caught. This suite fails the moment any
// of the three stops agreeing.
//
// Ported from Tusk's Vault. Two gates are deliberately absent here: there is
// no `npm run lint`, because this repository has no TypeScript to typecheck,
// and no contracts audit, because the invariants it would assert are asserted
// directly by test/module.test.mjs against the shipped module instead.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = f => readFileSync(path.join(ROOT, f), "utf-8");

describe("verify parity", () => {
  const pkg = JSON.parse(read("package.json"));

  it("`verify` runs the tests and the dev-mode tree audit", () => {
    const verify = pkg.scripts.verify;
    expect(verify).toContain("npm test");
    expect(verify).toContain("audit-current-tree.mjs --dev-mode");
  });

  it("the canonical pre-push hook calls `npm run verify`, not its own command list", () => {
    const hook = read("scripts/hooks/pre-push");
    expect(hook).toMatch(/npm run --silent verify/);
    // The hook must not re-list individual gates — that is how the drift
    // starts. (`npm run verify` naming the gates in a comment is fine; a
    // second `vitest` invocation is not.)
    expect(hook).not.toMatch(/\bnpx vitest\b|\bvitest run\b/);
  });

  it("the hook's stage-2 scanner and its fail-closed behaviour are intact", () => {
    const hook = read("scripts/hooks/pre-push");
    expect(hook).toContain("audit-push-range.mjs");
    // Missing scanner refuses the push instead of silently skipping.
    expect(hook).toMatch(/Refusing the push/);
    // Both public-destination matchers: remote name and URL shape.
    expect(hook).toContain('"public"');
    expect(hook).toContain("tusks-vault-vtt-dev");
  });

  it("excludes the dev remote before it matches the public one", () => {
    // `tusks-vault-vtt-dev` contains `tusks-vault-vtt`, so the arm order is
    // the whole correctness of the match: reversed, every ordinary dev push
    // runs the public scanner, and a gate that fires when it should not is a
    // gate that gets bypassed out of habit.
    const hook = read("scripts/hooks/pre-push");
    const dev = hook.indexOf("*tusks-vault-vtt-dev*)");
    const pub = hook.indexOf("*tusks-vault-vtt*) is_public=1");
    expect(dev).toBeGreaterThan(-1);
    expect(pub).toBeGreaterThan(-1);
    expect(dev).toBeLessThan(pub);
  });

  it("CI runs the same gates as verify", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("npm test");
    expect(ci).toContain("audit-current-tree.mjs --dev-mode");
  });

  it("CI covers Windows — the platform users actually run", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("windows-latest");
    expect(ci).toContain("ubuntu-latest");
    expect(ci).toMatch(/fail-fast:\s*false/);
  });

  it("CI builds the module, so a manifest that cannot ship fails here", () => {
    // `npm run build` runs verifyManifest(). Without this step a manifest
    // fault only surfaces when someone tries to cut a release.
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("npm run build");
  });
});

describe("the release script and the manifest agree", () => {
  it("tags with the prefix the download URL is built around", () => {
    const script = read("scripts/release-to-public.mjs");
    const manifest = JSON.parse(read("module/module.json"));
    const prefix = script.match(/TAG_PREFIX\s*=\s*"([^"]+)"/)?.[1];
    expect(prefix).toBe("foundry-v");
    // The invariant the script enforces at release time, asserted here too so
    // a manifest edit that breaks it fails the suite rather than a release.
    expect(manifest.download).toContain(`/${prefix}${manifest.version}/`);
  });

  it("points the public remote at the module repository, not the app's", () => {
    // Pushing the module's history to the app's repository would make
    // `releases/latest/download/module.json` resolve to an app release —
    // which is the exact failure the two-repository split exists to prevent.
    const script = read("scripts/release-to-public.mjs");
    const url = script.match(/PUBLIC_REMOTE_URL\s*=\s*"([^"]+)"/)?.[1];
    expect(url).toBe("https://github.com/KochiTusker/Tusks-Vault-Foundry.git");
  });
});
