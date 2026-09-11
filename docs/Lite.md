# Lite mode

Lite answers from journal entries in your own world, inside Foundry, with
nothing else installed. It is the half of this module that works on its own.

It is deliberately smaller than [Tusk's
Vault](https://kochitusker.github.io/Tusks-Vault/) — this page is as much about
where it stops as what it does.

Turn it on under **Module Settings → Where answers come from → Lite**.

---

## The folder

Lite reads a journal folder called **Tusk's Lore** by default. Make it in the
Journals sidebar, put entries in it, and that is your corpus — and you can point
it at folders you already have as well.

**Subfolders are read too**, as deep as you nest them, so organising into
*Tusk's Lore / NPCs*, *Tusk's Lore / Sessions* and so on works.

### You do not have to move your existing notes

If you already keep journals in folders of your own — and most GMs do, often
folders that came with an adventure you bought — open **Module Settings → Lite:
also read these folders** and tick them. Lite reads them alongside your lore
folder, subfolders and all.

Nothing is moved and nothing is copied. Your journals stay exactly where they
are, and Foundry's permissions still decide who can be answered from what.

You can also just rename the lore folder under **Lite: lore folder** if you would
rather point at a single folder you already have.

Anything outside those folders is invisible to Lite — including compendium
content, actor biographies and scene notes.

To see what Lite can actually read, press **F12** and run:

```js
TusksVault.lore()
```

That lists every page it found and how long each one is. If a note you expected
is missing, it is in a folder Lite is not reading — tick that folder, or move the
note.

## Two layers

### Layer 1 — search. On by default, costs nothing.

`/tusk who runs the harbour?` finds the passages that match and quotes them back,
each cited to the page it came from — and the citation is a link, so one click
opens the journal at that page.

**No API key, no network request, no cost, nothing leaves your machine.** It
matches the words you typed, so it rewards asking with the words your notes use.

### Layer 2 — written answers. Off by default.

Turn on **Lite: write answers** and set a **Gemini key**. Lite then sends the
matching passages to Google and writes prose from them, with the same citation
discipline — same journals, same folders, same permissions.

Google's [free tier](https://ai.google.dev/pricing) is enough to try it.

Choose the model under **Lite: model**. The picker lists what your key can
actually reach, best first; the module also moves itself off a model Google
retires, so a mid-session failure fixes itself rather than needing you.

## What each answer may draw on

**By default, Tusk reads everything in your lore folders, whoever is asking.**
The folder is the boundary: what you put in it is what the archivist may say.
Keep a reveal out of the folder until the party earns it.

Two other choices read Foundry's journal ownership instead — one for what the
whole table can open, and an experimental one that answers each person from the
pages they can open themselves. **[All three, and when to use
which](Settings.md#what-each-answer-may-draw-on)**.

The experimental one is worth knowing about even if you never switch it on,
because it is the one thing Lite does that [Tusk's
Vault](https://kochitusker.github.io/Tusks-Vault/) structurally cannot. Vault
reads files on disk, and a file carries no notion of who at your table may read
it. A journal page carries permissions you already maintain for other reasons —
so a player who writes their own backstory into the folder can be the only
person ever answered from it.

## Letting players add their own lore

Journal folders are not a permission boundary in Foundry, so anyone who can
create a journal entry can put one in your lore folder. That can be exactly what
you want — player backstories, session notes written by the table's
record-keeper.

- **Players need permission to create journals at all.** Foundry grants
  `JOURNAL_CREATE` to **Trusted Player and above** by default. Promote the
  player, or change it under *User Management → Configure Permissions*.
- **What they write is private to them by default.** Foundry makes the creator
  the owner and leaves everyone else at none. You can always read it; you are
  the GM.

Two things to know before you open this up:

- **On the default scope, what one player writes can answer another.** Every
  answer reads the whole folder. The [experimental per-player
  mode](Settings.md#the-experimental-per-player-mode) is what keeps a backstory
  private to its author.
- **A note in the folder is not merely quoted — its text goes into the prompt**,
  so somebody who can edit one can write instructions to the model. The module
  warns you when it finds an entry in your folder a player can edit. Why that
  matters, and what shrinks it: [SECURITY.md](../SECURITY.md).

See [the spoiler trade-off](Settings.md#the-spoiler-trade-off) before opening
either half up to players.

## Content filters are off by default

Google's safety filters are **off** unless you turn them on, matching Tusk's
Vault's own default.

A campaign archive gets asked about war, murder and worse, because that is what
your notes are about. A filtered refusal arrives looking like the archive not
knowing the answer, which is the least useful failure it could produce.

**Lite: apply Google's content filters** turns them back on if you would rather
have them.

## What a key in the browser means

The key is stored **in your browser only**. It is never written to the world, so
no player at your table can read it, and it is never sent to the Foundry server.

But **Foundry does not sandbox modules.** Every other module you have installed
runs on the same page and can read your browser's storage, including this key.

That is the whole of the warning, and it also appears in Foundry itself, in the
dialog that takes the key — you should not have to read a document to find it.
What to do about it — capping the spend, when to revoke, and why Tusk's Vault
keeps keys out of the browser entirely — is in
**[SECURITY.md](../SECURITY.md#what-can-still-read-a-key-in-your-browser)**.

## Only the GM's browser ever holds the key

Answers are written by the elected GM's client, not by whoever asked. A player's
browser never holds the key and never makes the call — it only ever sees the
answer that comes back.

With no GM connected, there is nothing that can answer, and the asker is told so
rather than left waiting.

## What Lite cannot do

Worth knowing before you decide it is not working properly:

- **It reads journal entries inside Foundry.** Not your Obsidian vault, not Word
  documents, not PDFs.
- **It only holds as much as fits in a single question.** A large campaign
  overflows that. The best match is included even if it has to be cut short, and
  the answer says *"Read 4 of 11 notes"* when something was left out — but the
  notes that did not fit are not considered.
- **It matches words, not meaning.** Letter for letter: `harbours` will not find
  `harbour`, and `wharf` will not find `harbour master`.
- **It forgets.** A question it could not answer leaves no trace, so the same
  gap surfaces again next session.
- **Gemini only**, and only with your own API key.

Each of those is something [Tusk's
Vault](https://kochitusker.github.io/Tusks-Vault/) does differently — see the
comparison in the [README](../README.md#what-moving-up-to-tusks-vault-gets-you).

## Trying it without the chat bar

Two console helpers, for when you want to check something without spending a
turn at the table:

```js
TusksVault.askLocal("who runs the harbour?")   // answer from journals, bypassing chat
TusksVault.lore()                              // what Lite can actually read
TusksVault.models()                            // which models your key can reach
```

## Where to go next

- **[Settings](Settings.md)** — who may ask, who sees the answer, renaming the
  command.
- **[Troubleshooting](Troubleshooting.md)** — when Lite answers with nothing.
- **[Hosted and cloud Foundry](Hosting.md)** — running on The Forge or a server
  you do not control.
- **[Tusk's Vault](https://kochitusker.github.io/Tusks-Vault/)** — the full
  archivist, and everything Lite defers to it on.
