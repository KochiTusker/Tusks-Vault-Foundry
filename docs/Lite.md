# Lite mode

Lite answers from journal entries in your own world, inside Foundry, with
nothing else installed. It is the half of this module that works on its own.

It is deliberately smaller than [Tusk's
Vault](https://kochitusker.github.io/Tusks-Vault/) — this page is as much about
where it stops as what it does.

Turn it on under **Module Settings → Where answers come from → Lite**.

---

## The folder

Lite reads one journal folder, named **Tusk's Lore** by default. Make it in the
Journals sidebar, put entries in it, and that is your corpus.

Rename it under **Module Settings → Lite: lore folder** if you already keep your
notes somewhere else. Anything outside that folder is invisible to Lite —
including compendium content, actor biographies and scene notes.

To see what Lite can actually read, press **F12** and run:

```js
TusksVault.lore()
```

That lists every entry it found and how long each one is. If a note you expected
is missing, it is in the wrong folder.

## Two layers

### Layer 1 — search. On by default, costs nothing.

`/tusk who runs the harbour?` finds the passages that match and quotes them back,
each cited to the entry it came from.

**No API key, no network request, no cost, nothing leaves your machine.** It
matches the words you typed, so it rewards asking with the words your notes use.

### Layer 2 — written answers. Off by default.

Turn on **Lite: write answers** and set a **Gemini key**. Lite then sends the
matching passages to Google and writes prose from them, with the same citation
discipline — same journals, same folder, same permissions.

Google's [free tier](https://ai.google.dev/pricing) is enough to try it.

Choose the model under **Lite: model**. The picker lists what your key can
actually reach, best first; the module also moves itself off a model Google
retires, so a mid-session failure fixes itself rather than needing you.

## Players only ever see what they could already read

Lite reads Foundry's own journal permissions. An entry a player cannot open is
never used to answer that player, so a GM-only note stays GM-only even when a
player asks the question that would surface it.

That check runs per asker, on every question. It is not a filter applied to the
answer afterwards — the entry never enters the corpus for that person at all.

This is stricter than the Bridge half, where Vault answers from your whole
archive and has no notion of Foundry permissions. See [the spoiler
trade-off](Settings.md#the-spoiler-trade-off) before opening either up to
players.

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
Only install modules you trust.

**Use a key made for this and nothing else, and set a spending cap on it** in
[Google's console](https://console.cloud.google.com/). That turns the worst case
from an open tab into a fixed number.

Tusk's Vault keeps the key off the browser entirely. It is free, and this is the
main reason to move up once you have decided you like this.

The same warning appears in Foundry, in the dialog that takes the key — you
should not have to read a document to find it. The full picture is in
[SECURITY.md](../SECURITY.md).

## Only the GM's browser ever holds the key

Answers are written by the elected GM's client, not by whoever asked. A player's
browser never holds the key and never makes the call — it only ever sees the
answer that comes back.

With no GM connected, there is nothing that can answer, and the asker is told so
rather than left waiting.

## What Lite cannot do

Worth knowing before you decide it is not working properly:

- **It reads one folder of journal entries.** Not your Obsidian vault, not Word
  documents, not PDFs.
- **It only holds as much as fits in a single question.** A large campaign
  overflows that, and the passages that did not fit are simply not considered.
- **It matches words, not meaning.** Ask about "the harbour master" when your
  notes say "the dockwarden" and it will not connect the two.
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
- **[Tusk's Vault](https://kochitusker.github.io/Tusks-Vault/)** — the full
  archivist, and everything Lite defers to it on.
