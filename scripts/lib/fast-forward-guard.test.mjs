import { describe, it, expect } from "vitest";
import { checkFastForward, REROOT_ENV } from "./fast-forward-guard.mjs";

const ZERO = "0".repeat(40);
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

// Fake git: `known` shas exist in the object store; `ancestors` maps
// "old..new" pairs that fast-forward.
function fakeGit({ known = [OLD, NEW], ancestorPairs = [] } = {}) {
  return argv => {
    if (argv[0] === "cat-file") return known.includes(argv[2]) ? 0 : 1;
    if (argv[0] === "merge-base") {
      return ancestorPairs.some(([a, b]) => a === argv[2] && b === argv[3]) ? 0 : 1;
    }
    throw new Error(`unexpected git call: ${argv.join(" ")}`);
  };
}

const line = (localSha, remoteSha, remoteRef = "refs/heads/main") =>
  `refs/heads/main ${localSha} ${remoteRef} ${remoteSha}`;

describe("checkFastForward", () => {
  it("allows a fast-forward push", () => {
    const git = fakeGit({ ancestorPairs: [[OLD, NEW]] });
    expect(checkFastForward([line(NEW, OLD)], git)).toEqual([]);
  });

  it("allows creating the branch (remote sha is zero — the root push)", () => {
    const git = fakeGit();
    expect(checkFastForward([line(NEW, ZERO)], git)).toEqual([]);
  });

  it("blocks a non-descendant push and names the consequence", () => {
    const git = fakeGit({ ancestorPairs: [] });
    const findings = checkFastForward([line(NEW, OLD)], git);
    expect(findings).toHaveLength(1);
    expect(findings[0].warning).toBeFalsy();
    expect(findings[0].detail).toMatch(/ff-only|descend/);
  });

  it("blocks when the published commit is absent locally — fetch first", () => {
    const git = fakeGit({ known: [NEW] });
    const findings = checkFastForward([line(NEW, OLD)], git);
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toMatch(/fetch/i);
    expect(findings[0].detail).toMatch(/unverifiable/i);
  });

  it("blocks deleting the published branch, with no reroot override", () => {
    const git = fakeGit();
    const blocked = checkFastForward([line(ZERO, OLD)], git, { allowReroot: true });
    expect(blocked).toHaveLength(1);
    expect(blocked[0].warning).toBeFalsy();
    expect(blocked[0].detail).toMatch(/DELETE/);
  });

  it("a deliberate re-root downgrades to a loud warning", () => {
    const git = fakeGit({ ancestorPairs: [] });
    const findings = checkFastForward([line(NEW, OLD)], git, { allowReroot: true });
    expect(findings).toHaveLength(1);
    expect(findings[0].warning).toBe(true);
    expect(findings[0].detail).toContain(REROOT_ENV);
  });

  it("ignores refs outside the guarded set", () => {
    const git = fakeGit({ ancestorPairs: [] });
    expect(checkFastForward([line(NEW, OLD, "refs/heads/gh-pages")], git)).toEqual([]);
    expect(checkFastForward([line(NEW, OLD, "refs/tags/v1.0.0")], git)).toEqual([]);
  });
});
