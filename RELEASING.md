# Releasing this module

How a version reaches a stranger's Foundry. Two audiences read this: whoever
cuts a release, and whoever is trying to work out why an install went wrong.

## How Foundry actually installs a module

Worth having straight before changing anything, because every URL rule below
follows from it.

1. The GM clicks **Install** in the package browser, or pastes a **Manifest
   URL**. Either way Foundry fetches a JSON manifest.
2. Foundry reads **`download`** out of that manifest, fetches it, and unzips it
   into `Data/modules/<id>/`. The `id` in the manifest is the directory name.
3. On every update check Foundry re-fetches **`manifest`** — the *stable* URL —
   and compares its `version` against the installed one. If the remote is newer
   it fetches that manifest's `download`.

Three consequences, all of them enforced by `verifyManifest()` in
[`tools/lib/module.mjs`](tools/lib/module.mjs):

- **`manifest` must be stable.** Version-pin it and the update check re-reads
  the same version forever, so no installed copy ever updates again.
- **`download` must be version-pinned.** Point it at `latest` and every update
  check fetches an artifact whose version it has already installed.
- **`module.json` must be at the root of the zip**, beside the `scripts/`,
  `styles/` and `lang/` directories it names. A zip built around a wrapping
  folder installs a module whose every file is one level below where the
  manifest says it is; it loads nothing, and says nothing about why.

`npm run build` produces both artifacts, and the suite parses the archive it
builds to check that last point rather than trusting it.

## The two repositories

Day-to-day work happens on `origin` (`Tusks-Vault-VTT-Dev`, private). The
public repository `Tusks-Vault-Foundry` is written only by `npm run release`,
which builds the release commit in a temporary index — your working tree is
never touched — and pushes it to the `public` remote.

Set the remote up once, and install the repository's git hooks once per
machine (they live outside the tracked tree, so a fresh clone has none):

```bash
git remote add public https://github.com/KochiTusker/Tusks-Vault-Foundry.git
npm run hooks:install
```

`npm run verify` must be clean before any of this. Maintainers with dev-repo
access: `docs/dev/release-gate.md` covers what runs on a public push and what
to do when it refuses one.

## Cutting a release

```bash
npm run verify && npm run build
```

1. **Bump the version in two places, to the same value:**
   `module/module.json` → `version`, and `package.json` → `version`. The build
   refuses to run if they disagree, and refuses a `--version` argument that does
   not match the manifest.
2. **Update `download`** in `module/module.json` to the new tag:
   `.../releases/download/foundry-v<version>/module.zip`. Leave `manifest`
   pointing at `releases/latest/download/module.json`.
3. **Build.** `npm run build` writes `dist-module/module.json` and
   `dist-module/module.zip`.
4. **Publish the source and the tag.**

   ```bash
   npm run release:dry-run     # builds the commit, pushes nothing
   git show --stat <sha>       # inspect the file list before it is public
   npm run release             # pushes commit + tag foundry-v<version>
   ```

   The version is not an argument you pick — it is read from
   `module/module.json`, and the tag is `foundry-v<version>` because that
   exact string is baked into the manifest's `download` URL. Passing a version
   only asserts which one you think you are shipping; a mismatch stops the run.

5. **Create the GitHub Release** on that tag, and attach **both** built files.

   A pushed tag is not a Release, and Foundry fetches `module.zip` from a
   Release *asset* — so stopping at step 4 leaves a public repository nobody
   can install from. Attach both, not just the zip: the tag-specific
   `module.json` is what the Foundry package admin page and the Package
   Release API need, and the `latest` alias resolves to it for the update
   check.

> **Why this repository holds only the module.**
> `releases/latest/download/module.json` resolves to the newest GitHub Release
> *in the repository*, not the newest release whose tag looks like a module. If
> the app and the module shipped from one repository, publishing a single app
> release would make `latest` resolve to it, `module.json` 404, and **every
> installed copy silently stop seeing updates, permanently.** Nothing warns.

## What actually breaks updates

Foundry never reads this repository's git history. An update check is only ever
three steps: fetch the `manifest` URL, compare `version` with what is installed,
and if it is newer download that manifest's `download` URL. No commits, no
branches, no ancestry.

So the orphan-rooted public history cannot break an install, and neither could
a re-root. That is worth stating because the two things are easy to conflate —
the history strategy is about the repository being reviewable and clonable, not
about Foundry.

What DOES break updates, in rough order of how easy it is to do by accident:

- **Marking the GitHub Release as a pre-release.** GitHub's `latest` is the
  newest **non-prerelease, non-draft** release, so `releases/latest/download/
  module.json` silently resolves to the previous one and every install stops
  seeing the new version. A draft does the same.
- **Publishing the tag but not the Release.** `npm run release` pushes a commit
  and a tag; the assets hang off a GitHub *Release*, which is a separate object.
  A tag alone means `latest/download/…` has nothing to serve.
- **Version-pinning `manifest`.** Every check then re-reads the same version and
  no installed copy ever updates. `verifyManifest()` refuses this.
- **Pointing `download` at `latest`.** Every check fetches an artifact whose
  version is already installed. Also refused.
- **Not raising `version`.** Foundry compares the two; equal is not newer.
- **Changing `id`.** It is the install directory *and* the namespace for every
  setting and flag. Changing it orphans every world's configuration.
- **Deleting or re-pointing a published tag.** Every `download` URL already in
  the wild names that tag. Moving it 404s installs that have not updated yet.
- **Publishing anything else from this repository.** `releases/latest` is
  repository-wide, not tag-filtered — see the note above.

One subtlety in GitHub's rule: "latest" is decided by the release's `created_at`,
which is the **date of the commit** the release points at, not when you
published it. The release script stamps each release commit with the time it
was built, so releases cut in order are ordered correctly. Cutting a release
from an older commit is the case to avoid.

## Listing it on Foundry's package registry

### First release only — the submission form

<https://foundryvtt.com/packages/submit>, linked from the bottom of the Systems
and Modules page.

- **Package Name** must be exactly the manifest `id`: `tusks-vault`.
- **Package Title** is the display name: `Tusk's Vault`.
- **Package URL** is the repository URL —
  `https://github.com/KochiTusker/Tusks-Vault-Foundry`. This is the submission
  form's field, and it is deliberately *not* the same as the manifest's `url`,
  which points at the documentation site.

A person reviews it, usually within a few days, and then grants access to the
package's admin pages.

### Every release after that

Either the package admin page, or the
[Package Release API](https://foundryvtt.com/article/package-release-api/):

```
POST https://foundryvtt.com/_api/packages/release_version/
Authorization: <the fvttp_… release token from the package's admin page>

{
  "id": "tusks-vault",
  "dry-run": true,
  "release": {
    "version": "1.0.0",
    "manifest": "https://github.com/KochiTusker/Tusks-Vault-Foundry/releases/download/foundry-v1.0.0/module.json",
    "notes": "https://github.com/KochiTusker/Tusks-Vault-Foundry/releases/tag/foundry-v1.0.0",
    "compatibility": { "minimum": "13", "verified": "14" }
  }
}
```

**The `manifest` in that payload is the version-pinned one**, not the `latest`
alias — the opposite of the rule for the `manifest` field *inside* the file. The
registry is recording where this specific version can always be fetched from;
the file is telling an installed copy where to look for the next one. Getting
these the wrong way round is the classic mistake, which is why the tag-specific
`module.json` is attached to the release at all.

Run it once with `"dry-run": true` first. A version can only be released once.

## Before the first submission

The reviewer follows the links, and so does everyone who arrives from the
package browser. These are not yet true — see
[`docs/DocsLinks.md`](docs/DocsLinks.md).

- [ ] `KochiTusker/Tusks-Vault-Foundry` exists and is **public**, created
      independently rather than as a fork, and `npm run release` has published
      to it.
- [ ] A release tagged `foundry-v<version>` exists there carrying both artifacts,
      and `releases/latest/download/module.json` resolves.
- [ ] `KochiTusker/Tusks-Vault` is **public** — the README links it as the app
      this module bridges to.
- [ ] <https://kochitusker.github.io/Tusks-Vault/> resolves, and says above the
      fold that Vault is a separate app to install first. Foundry shows this URL
      as the package's website.
- [ ] <https://kochitusker.github.io/Tusks-Vault/docs/surfaces/foundry-vtt/>
      resolves. Foundry links it as the package's readme.
- [ ] Consider adding a `media` entry to the manifest — Foundry renders a cover
      image in the package browser, and its absence is conspicuous next to
      packages that have one. It is omitted today rather than pointed at a file
      that does not exist.
- [ ] Install the built zip into a clean Foundry from the manifest URL, on
      **v13** as well as v14. `compatibility.minimum` claims v13 and only v14 has
      been exercised; the suite cannot check this, because Foundry cannot run in
      CI.

## What the suite will not catch

`npm test` runs the module's logic against stubs of the Foundry globals it
touches. It proves the manifest is publishable and that the code does what it
says against Foundry's documented contracts. It cannot prove the module works in
Foundry, because Foundry cannot run in CI. The last checklist item above is the
only thing that does.
