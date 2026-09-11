# Changelog

Every released version of the Foundry module, newest first.

This file is what Foundry links as the package's changelog, so it is written for
a GM deciding whether to update — what changed for them, and whether anything
needs their attention — rather than for someone reading the diff. The
[releases page](https://github.com/KochiTusker/Tusks-Vault-Foundry/releases)
carries the same notes alongside the downloadable files.

Versions follow [semantic versioning](https://semver.org/): the middle number
changes when something is added, the last when something is fixed.

---

## 1.1.0

**Update if you let players ask questions.** This release fixes a case where a
journal page you had restricted could be used to answer someone who could not
open it.

### Fixed

- **Journal permissions are read page by page, not entry by entry.** A page you
  had restricted inside an entry the table can read was previously used to
  answer anyone, and a page you had shared inside an entry they could not open
  was wrongly ignored. Both now behave as the documentation always said.
  This only ever applied when answers were being scoped by ownership.
- **Subfolders are read.** Organising notes into `Tusk's Lore / NPCs` used to
  produce an empty archive and an error asking you to create a folder you had
  visibly already created.
- **A long note is no longer silently discarded.** Anything too large to fit
  into one question used to be dropped without a word, so the answer could be
  "I am unsure about this detail" while the passage sat in the note that had
  been thrown away. The best match is now included even if it has to be cut
  short, taken around the part that matched, and the card says *"Read 4 of 11
  notes"* when something was left out.
- **Ranking no longer favours whichever journal happened to be biggest.** A
  forty-page NPC compendium used to outrank the one-page note that actually
  answered the question.
- **Choosing a model no longer gets undone when you save.** Picking a model from
  *Lite: model picker* left the box above it showing the old name — and because
  Foundry's settings panel writes back every field it is holding, pressing
  **Save Module Settings** put the old model back over your choice. The same
  applied when the module moved itself off a model Google had retired: a
  settings panel left open could undo the repair.

### Added

- **Citations name the page and are links.** One click opens the journal at that
  page instead of at the top of a forty-page entry. A citation naming something
  that was not in the archive is shown struck through rather than looking like a
  real source.
- **Read the folders you already have.** *Lite: also read these folders* lets you
  tick journal folders you already keep notes in. Nothing is moved or copied.
- **What each answer may draw on.** By default Tusk reads everything in your lore
  folders, whoever asks. Two opt-in settings read Foundry's journal ownership
  instead — one for what the whole table can open, and an experimental one that
  answers each person from the pages they can open themselves.
- **Review lore permissions.** A table of every page in your folders and which
  players can be answered from it.
- **A welcome screen** on first run, which asks whether to use Lite or connect to
  Tusk's Vault and creates the lore folder for you. Existing worlds never see it.
- **A FAQ and an About screen**, both in module settings. About carries a
  **Copy diagnostics** button, so filing a useful bug report no longer requires
  the browser console.
- **[Hosted Foundry documentation](docs/Hosting.md).** Both halves work on The
  Forge and similar hosts, including the full Tusk's Vault — it runs on the
  machine you play from, not on the server.

### Changed

- **The line about the full version no longer appears on every answer.** It now
  appears only when you have actually met a limit: nothing found, the archive
  too large for one question, or written answers switched on with no key.
- **Under the experimental per-player setting**, an answer built from pages not
  everyone can read is whispered to you and the asker rather than posted
  publicly, even when answers are set to go to everyone.

### Upgrading

Nothing to do. Your settings, your folder and your pairing are unchanged.

**Your world keeps answering the way it did.** *What each answer may draw on* is
new, and a new world reads the whole lore folder — but an existing world is
pinned on update to the behaviour it already had, where each person is answered
only from journal pages they can open. You are told once, and can change it in
module settings whenever you like.

---

## 1.0.3

Housekeeping: the module's own documentation and release process. No change to
how it behaves in a game.

## 1.0.2

Documentation and packaging corrections.

## 1.0.1

### Fixed

- **Recover when the stored Vault address stops being Vault.** Pointing the
  module at something that was not Tusk's Vault — usually Foundry itself, after
  a hand-edited address — produced a confusing failure instead of rediscovering
  Vault on its usual ports.

## 1.0.0

First public release.

- Ask your campaign's lore from the chat bar with `/tusk`, or by mentioning the
  archivist by name.
- **Lite** answers from journal entries in your own world, with nothing else
  installed and no API key. Optionally writes prose answers with your own Gemini
  key.
- **Bridge** connects Foundry to [Tusk's
  Vault](https://kochitusker.github.io/Tusks-Vault/), pairing with a six-digit
  code shown on both ends.
- Control over who may ask and who sees the answer, by rank plus named
  exceptions.
- `TusksVault.diagnostics()` for bug reports, written to be safe to paste in
  public.
