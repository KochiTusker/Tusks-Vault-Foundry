// Fast-forward guard for pushes to the public remote's main branch.
//
// WHY: the in-app updater (scripts/update.mjs) runs `git pull --ff-only`.
// A push that replaces public/main with a commit that is NOT a descendant
// of the published one (a re-root, a rebase, a force-push of an unrelated
// branch) makes that pull fail with "Not possible to fast-forward" for
// EVERY existing install simultaneously, and the updater has no fallback —
// each user's only recovery is a manual re-clone. Public history is
// therefore one root and then strictly linear, and this guard is what makes
// that a property of the repository rather than a sentence in a document.
//
// A deliberate re-root stays possible — some day there may be something in
// the history that cannot be left there, and rewriting is the only way to
// remove it — but it must cost a conscious act: set TUSKS_ALLOW_REROOT=1,
// and the guard downgrades its block to a loud warning. It should never
// happen by accident, and it should never happen silently.

export const REROOT_ENV = "TUSKS_ALLOW_REROOT";

const ZERO_SHA = "0000000000000000000000000000000000000000";

/**
 * Check the refs of one push against the fast-forward rule.
 *
 * @param refLines  git's pre-push stdin lines: `<local-ref> <local-sha> <remote-ref> <remote-sha>`
 * @param gitStatus callback `(argv: string[]) => exitCode` — injected so the
 *                  test can drive the guard with a fake git instead of
 *                  building real repositories.
 * @param opts.allowReroot  downgrade a non-fast-forward block to a warning.
 * @param opts.guardedRefs  remote refs the rule applies to. Only main by
 *                  default; a docs-site branch that is rebuilt parentless on
 *                  every publish (and that nobody pulls) would be listed as
 *                  exempt by omission here.
 * @returns findings; ones with `warning: true` are advisory, the rest block.
 */
export function checkFastForward(
  refLines,
  gitStatus,
  { allowReroot = false, guardedRefs = ["refs/heads/main"] } = {}
) {
  const findings = [];
  for (const line of refLines) {
    const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
    if (!guardedRefs.includes(remoteRef)) continue;

    // Deleting the published branch strands every install at once — worse
    // than any re-root, and never legitimate. No override.
    if (localSha === ZERO_SHA) {
      findings.push({
        layer: "fast-forward",
        file: remoteRef,
        commit: "",
        detail: `push would DELETE ${remoteRef} on the public remote — every install pulls from it`,
      });
      continue;
    }

    // Branch doesn't exist on the remote yet: this push creates the root.
    if (remoteSha === ZERO_SHA) continue;

    // The published commit must be in the local object store before descent
    // can be verified. Unverifiable is not the same as safe.
    if (gitStatus(["cat-file", "-e", remoteSha]) !== 0) {
      findings.push({
        layer: "fast-forward",
        file: remoteRef,
        commit: remoteSha.slice(0, 7),
        detail:
          `the published commit ${remoteSha.slice(0, 7)} is not in the local object store, so ` +
          `descent cannot be verified. Run \`git fetch public main\` first — unverifiable is not the same as safe.`,
      });
      continue;
    }

    if (gitStatus(["merge-base", "--is-ancestor", remoteSha, localSha]) !== 0) {
      findings.push({
        layer: "fast-forward",
        file: remoteRef,
        commit: localSha.slice(0, 7),
        warning: allowReroot,
        detail: allowReroot
          ? `RE-ROOT IN PROGRESS (${REROOT_ENV}=1): ${localSha.slice(0, 7)} does not descend from the published ` +
            `${remoteSha.slice(0, 7)}. Every existing install's updater will fail after this push; they need the documented recovery.`
          : `${localSha.slice(0, 7)} does not descend from the published ${remoteSha.slice(0, 7)} — this push would ` +
            `break \`git pull --ff-only\` for every existing install. Build the release as a child of the published ` +
            `commit (npm run release does this), or — only for a deliberate history rewrite — set ${REROOT_ENV}=1.`,
      });
    }
  }
  return findings;
}
