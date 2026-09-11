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

## 1.1.1

**Update if you use Lite.** A settings panel promised something the default does
not do, the note under capped answers blamed the wrong thing, and a player could
spend your Gemini key without limit. Nothing here changes how your world is set
up.

### Fixed

- **The lore folder's description no longer promises what the default does not
  do.** It read *"entries a player cannot open are never used to answer that
  player"* — which is true only under the two per-player settings, and has not
  been true of the default since 1.1.0. Four lines below it, the panel correctly
  said the opposite. The description now points at the setting that decides,
  rather than making a promise on its behalf.
- **You are told when the wide default is quoting pages your players cannot
  open.** The warning about the lore folder only ever asked whether a player
  could *edit* something in it. A perfectly locked-down folder therefore got
  silence, while every answer was free to quote it. You are now told once how
  many pages that is, and where to change it. Nothing about it is a fault —
  reading the whole folder is what the default means — but it should be a
  decision rather than a discovery.
- **"Read 4 of 11 notes" counted the wrong thing.** The second number was every
  note in your folders, not the notes that matched your question — so a hundred
  notes with three matches said *"Read 3 of 100 notes, the rest did not fit"*
  and invited you to prune a folder that was fine. It now counts what matched,
  and being too long to read in full is reported separately from not fitting at
  all, because those have different answers.
- **A player cannot run up your Gemini bill.** Questions are capped in length,
  and each person may have one question in the air at a time. A real table never
  meets either — nobody asks again before the answer arrives — but a script
  cannot get past them. A spending cap in the Google console is still the only
  hard limit, and the security notes say so.
- **A private answer is never posted publicly first.** When answers go to the
  whole table but the archivist drew on notes not everyone can open, the answer
  arrives as a private message from the moment it exists, rather than a public
  one being narrowed afterwards. The table still sees that a question was
  answered.
- **A question can no longer vanish in silence.** If another module blocks the
  archivist's chat card, you now get a short failure with a code instead of the
  question sitting in the log with nothing ever coming back.
- **Losing your internet says so.** A Lite answer that could not reach Google
  used to show the browser's own wording — *"Failed to fetch"* — which sends you
  to check a Foundry connection that is visibly working. It now says what
  happened, and says something different when Google simply took too long.
- **A page name can no longer impersonate the archivist's own instructions**, and
  a written answer can no longer make Foundry render links or dice rolls that
  nothing in your notes asked for.
- **Two folders with your lore folder's name** are reported instead of silently
  picking one, which used to present as "it is not reading my notes".
- **The model you picked is protected from a second GM's open settings panel.**
  1.1.0 fixed this for the GM doing the picking; a second GM with the panel open
  on another machine could still put the old model back.
- **Smaller things.** An emoji at the edge of a quoted passage is no longer cut
  in half; a screen that fails to open says so instead of doing nothing; an
  error shown to the table no longer carries your Vault address.

### Upgrading

Nothing to do, and nothing changes about how your world answers. If you have
edited `liteScope` by hand to a value that is not one of the three offered, Tusk
now reads only what the whole table can open rather than everything — an
unreadable setting is a reason to show less, not more.

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
