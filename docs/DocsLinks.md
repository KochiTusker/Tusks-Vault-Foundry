# The documentation links this module hard-codes

Tusk's Vault is the product. This module is the Foundry-shaped edge of it, and
it deliberately owns almost no documentation of its own — a GM who installs it
needs to be reading about Vault, not about a bridge.

That makes a handful of URLs part of this repository's contract with the Vault
one. They are compiled into the shipped `module.json`, which means **they are
baked into every install** and cannot be corrected without publishing a new
release. A URL that 404s here is a dead end inside Foundry's own package
browser, where nobody can see a redirect.

## The rule

**Changing one of these means changing the page it points at, in the same
change.** Every URL below is referenced from a file that ships to strangers.

## The links

| URL | Referenced from | What has to be there |
|---|---|---|
| `https://kochitusker.github.io/Tusks-Vault/` | `module.json` → `url` and `description`; `README.md` throughout | The documentation site's landing page. Foundry shows `url` in the package browser as the package's website, so this is where an installer arrives from inside Foundry. It has to explain, above the fold, that Tusk's Vault is a separate app they need to install. |
| `https://kochitusker.github.io/Tusks-Vault/docs/surfaces/foundry-vtt/` | `module.json` → `readme` | The Foundry tutorial: installing Vault, switching the Foundry surface on, pairing, asking, and the access settings. Foundry links this as the package's readme. |
| `https://github.com/KochiTusker/Tusks-Vault` | `README.md`, `Troubleshooting.md` | The Vault source repository. |
| `https://github.com/KochiTusker/Tusks-Vault-Foundry` | `module.json` → `license`, `bugs`, `changelog`, `manifest`, `download` | This repository, public. See [RELEASING.md](../RELEASING.md). |

### Deep links, from the Markdown pages only

None of these are compiled into `module.json`, so a broken one is a bad link on a
page rather than a dead end inside Foundry. They still ship to strangers.

| URL | Referenced from | What has to be there |
|---|---|---|
| `…/docs/getting-started/installation/` | `README.md` | Installing Vault. |
| `…/docs/getting-started/choosing-a-provider/` | `README.md` | Picking a model provider. |
| `…/docs/about/what-it-costs/` | `README.md` | What running Vault costs. |
| `…/docs/lore/obsidian-vault/` | `README.md` | Pointing Vault at notes you already keep. |
| `…/docs/troubleshooting/faq/` | `Troubleshooting.md` | Vault's own FAQ. |
| `…/docs/troubleshooting/known-issues/` | `Troubleshooting.md` | Vault's known issues. |

The site mirrors the layout of
[Tusk's Tomes](https://kochitusker.github.io/Tusks-Tomes/), the sister project,
which uses `/<repo>/docs/<section>/<page>/`. Every URL above follows that scheme
and already exists on the site's `gh-pages` branch.

## This repository has no documentation site

The pages in `docs/` are ordinary Markdown, read on GitHub. There is no Pages
site here and there should not be: a second site would split the documentation
across two places and give a GM two front doors to guess between.

Everything about Vault itself — models, costs, providers, tutorials — belongs on
the Vault site. Everything about the Foundry *bridge* — settings, Lite mode,
diagnostics — belongs in `docs/` here, next to the code it describes.

## Both links must resolve before the registry submission

`module.json` points its `url`, `readme` and `description` at the documentation
site, and the Foundry package submission is reviewed by a person who follows
those links. An installer clicking through from the package browser has to land
somewhere that tells them what to install first — this module does nothing on
its own.

So the site and the repository behind these links are a **precondition of
submitting**, not of releasing: the pre-submission checklist in
[RELEASING.md](../RELEASING.md) verifies each one at the point it matters.

(This section used to record which of them did not exist yet. That was true
when it was written and false shortly afterwards, in a file that ships to the
public repository — a status note in a document that outlives the status. The
checklist is the right home for it.)

## Why the dependency is not in `relationships`

Foundry's manifest has a `relationships.requires` field, and it is the obvious
place to declare that this module needs Tusk's Vault. It cannot be used for it.

A `RelatedPackage` entry's `type` is `module`, `system` or `world` — Foundry
resolves the `id` against its own package registry to offer or block the
install. Tusk's Vault is a desktop application that will never be listed there,
so declaring it would make Foundry block installation of this module on a
package it can never find.

The dependency therefore lives in **`description`**, which is the text the
package browser renders beside the Install button, and it is asserted by
`verifyManifest()` in [`tools/lib/module.mjs`](../tools/lib/module.mjs) so it
cannot be quietly edited away. `test/module.test.mjs` also asserts that a
`relationships` entry naming a non-package type is rejected, so the
obvious-looking fix fails a test rather than a stranger's install.
