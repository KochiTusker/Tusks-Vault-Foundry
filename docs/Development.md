# Development

```bash
npm install
npm run verify     # the tests, plus the repository audits
npm run build      # writes dist-module/module.json and module.zip
```

## Testing against a VTT nothing can run in CI

There is no CI that can run Foundry, so `test/module-runtime.test.mjs` drives
both chat hooks end to end against stubs of the Foundry globals the module
touches.

That is not a claim the module works in Foundry — only that its logic does what
it says against Foundry's documented contracts. The stubs model the shapes
Foundry actually delivers, including the ones that differ between v13 and v14.

`test/vault-contract.test.mjs` asserts this side of the wire protocol. The
protocol itself is specified on the Vault side, in `docs/tooling/foundry-contract.md`
— **a change to it is a change to both repositories.**

## The module's own shape

Everything ships from `module/`, and nothing else does:

| Path | What it is |
|---|---|
| `module/scripts/tusk.js` | The whole module. No bundler, no dependencies. |
| `module/module.json` | The manifest Foundry reads. |
| `module/lang/en.json` | Every string the module can show. |
| `module/styles/tusks-vault.css` | Chat styling, in both Foundry themes. |

`tools/build-module.mjs` writes the release zip and runs `verifyManifest()`,
so a manifest that cannot ship fails the build rather than the release.

## Repository layout

| Path | What it is |
|---|---|
| `scripts/audit-*.mjs` | The disclosure, secret and private-name scanners. |
| `scripts/lib/` | Their shared machinery, each part unit-tested. |
| `scripts/release-to-public.mjs` | Publishes a release to the public remote. |
| `scripts/hooks/pre-push` | Runs the scanners before anything leaves the machine. |

Install the hooks once, per clone:

```bash
npm run hooks:install
```

## Documentation

- [`DocsLinks.md`](DocsLinks.md) — the documentation URLs this module hard-codes,
  and what has to exist at each. Changing one means changing the page it points
  at, in the same change.
- [`../RELEASING.md`](../RELEASING.md) — how a version reaches Foundry's package
  registry.

**This repository has no documentation site.** The pages here are ordinary
Markdown, read on GitHub. The site lives in
[Tusk's Vault](https://kochitusker.github.io/Tusks-Vault/), and anything about
Vault itself belongs there rather than here.

## Contributing

The module is one file on purpose, and it is commented to explain *why* rather
than *what* — a change that removes a rationale loses more than it saves.

Two things the tests will hold you to:

- **Every credential the module stores needs a line in
  [`../SECURITY.md`](../SECURITY.md)**, and every host it can reach needs one in
  [`Privacy.md`](Privacy.md). Both are asserted against the source.
- **Answer text is escaped once, at the top of `renderAnswer`.** Everything after
  that point operates on already-escaped text and only ever adds tags of its own.
  Model output lands in a log every player renders.
