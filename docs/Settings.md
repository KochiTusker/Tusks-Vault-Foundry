# Module settings

These are this module's own controls, under **Settings → Game Settings → Module
Settings → Tusk's Vault**.

Everything else — which model answers, what it costs, what leaves your machine,
what Vault does with your documents — is a **Vault** setting, and lives on
[the documentation site](https://kochitusker.github.io/Tusks-Vault/).

---

## The settings

| Setting | Scope | What it does |
|---|---|---|
| **Enable in this world** | World | Turn the archivist off without uninstalling. |
| **Where answers come from** | World | Lite (journals in this world) or Bridge (Tusk's Vault). |
| **Who may ask** | World | The lowest rank that may put a question. [See below.](#who-may-ask) |
| **Chosen askers** | World | Named people who may always ask, whatever their rank. |
| **Who sees the answer** | World | Where the answer is posted. Set separately from who may ask. |
| **Chat command** | World | Defaults to `/tusk`. |
| **Archivist name** | World | The name answers post under, and the `@mention` that also asks. |
| **Vault address** | Per browser | Leave blank to find Vault automatically. |
| **Lite: lore folder** | World | Which journal folder Lite reads, and everything nested inside it. Defaults to *Tusk's Lore*. |
| **Lite: also read these folders** | World | Tick journal folders you already keep notes in. Nothing moves, nothing is copied. |
| **Lite: what each answer may draw on** | World | Everything in the folders (default), or Foundry's journal ownership. [See below.](#what-each-answer-may-draw-on) |
| **Lite: review lore permissions** | — | Lists every page in the folder and who can be answered from it. |
| **Lite: write answers** | World | Prose answers instead of quoted passages. Needs a key. |
| **Lite: model** | World | Which Gemini model writes them. |
| **Lite: apply Google's content filters** | World | Off by default. [Why.](Lite.md#content-filters-are-off-by-default) |
| **Gemini key** | Per browser | Never stored in the world. [What that means.](Lite.md#what-a-key-in-the-browser-means) |
| **Common questions** | — | A FAQ, each answer linking to the page that covers it in full. Players can open it too. |
| **About Tusk's Vault** | — | Version, links, a diagnostics report you can copy, and how to support the project. |

**World** settings are shared by everyone in the world and only a GM can change
them. **Per browser** settings live in one person's browser and never reach the
Foundry server or another player.

## Who may ask

A rank, plus named exceptions. The two combine — the list only ever **adds**
access, never removes it.

| Rank | Who it admits |
|---|---|
| **Nobody by rank** | Only the chosen askers below. |
| **Gamemaster only** | Full GMs. *Not* Assistant GMs. |
| **Assistant GM and above** | What Foundry itself calls a GM. |
| **Trusted Player and above** | Trusted players, Assistants and GMs. |
| **Anyone at the table** *(default)* | Everyone. |

**Chosen askers** is a tick-list of the world's users. Use it for a co-GM on a
player account, or a single loremaster at an otherwise closed table. Set the rank
to *Nobody by rank* and the list becomes the whole policy.

Someone refused is told so privately, whispered to them and to you — not
announced to the table.

## Who sees the answer

| Setting | Who reads it |
|---|---|
| **The asker and the GM** *(default)* | Whispered to whoever asked, plus connected GMs. |
| **The GM only** | Whispered to GMs. The asker is told their question went to you. |
| **Everyone, in the open** | Posted to the chat log. |

## What each answer may draw on

| Setting | What it does |
|---|---|
| **Everything in the lore folders** *(default)* | One archive, one answer for everybody. The folder is the boundary: what you put in it is what Tusk may say. |
| **Only what every player can open** | Answers only from notes the whole table can read. |
| **Only what the person asking can open** *(experimental)* | Reads Foundry's journal ownership per person, page by page. Two players can ask the same question and get different answers. |

**The default reads everything, and that is deliberate.** Foundry creates every
journal entry with no player access at all, so an archivist that filtered by
ownership out of the box would answer "I could not find anything" to every player
question until you had opened the Ownership Configuration dialog for every entry.

On the default, spoiler control is **what you put in the folder** and
**[who may ask](#who-may-ask)**.

### The experimental per-player mode

If you keep journal permissions up to date, *Only what the person asking can
open* reads them: each person is answered from the pages they could open
themselves, and a player's own backstory answers them and nobody else.

It is experimental because it is only as good as those permissions. An entry left
on Foundry's default ownership answers nobody but you, which looks like a fault
rather than a setting. **Check it with *Lite: review lore permissions*** before
relying on it.

In this mode only, an answer built from pages not everyone can read is whispered
to the asker and the GMs rather than posted publicly, even if *Who sees the
answer* says everyone — otherwise the two settings cancel out.

> **One combination to avoid.** On the default scope, if players can edit notes
> in your lore folder, what they write goes **into the prompt** beside lore they
> cannot read — so somebody who can write a note can write instructions to the
> model. The module warns you when it finds such an entry. Either move those
> entries out of the folder, or use the per-player mode, where it is contained.
> See [letting players add their own lore](Lite.md#letting-players-add-their-own-lore).

## The spoiler trade-off

**Who sees the answer bounds visibility. It does not bound what a player can
pull.**

In Bridge mode the archive answers from your whole corpus and has no notion of
what you have revealed yet, so a player who asks about a sealed strongbox can be
whispered its contents. The whisper hides that from the rest of the table — not
from the player who asked.

Three ways to handle it, in increasing strictness:

1. **Restrict [Who may ask](#who-may-ask)** so players cannot put questions at
   all.
2. **Set Who sees the answer to _The GM only_**, so you read it first and pass on
   what you choose.
3. **Leave Vault's own "Answer players, not just the GM" switch off** — it is off
   by default, and with it off, player questions are refused no matter what this
   module says.

**Lite shares this trade-off on its default scope**, which reads the whole
folder whoever asks. The [experimental per-player
mode](#the-experimental-per-player-mode) is what closes it: a page a player
cannot open is never used to answer them.

## Renaming the command

**Chat command** and **Archivist name** both change how you ask. `/tusk` becomes
`/lore` or `/ask`; the archivist's name is both what answers post under and an
`@mention` that also asks.

If a rename stops the command working, check it against what the module actually
parses:

```js
TusksVault.selfTest()
```

`parsesConfiguredCommand` and `parsesLiteralSlashTusk` tell a renamed trigger
apart from a broken one — both look identical from the chat bar.

## The Vault address

Leave it blank. The module scans ports 3000–3019 on your own machine and finds
Vault by itself, which is what pairing does for you.

Set it by hand only if you run Vault on a port outside that range. It must be a
full origin — `http://127.0.0.1:3050`, not `127.0.0.1:3050` or `:3050`.

A credential is bound to the exact address you paired from, so **opening the same
world at a different address needs pairing again** — `localhost` to a LAN IP when
you start hosting for the table, or `http` to `https` behind a proxy. That is a
correct refusal rather than a fault, and the chat message says so.

## Where to go next

- **[Lite mode](Lite.md)** — the half that needs nothing else installed.
- **[Troubleshooting](Troubleshooting.md)** — when a setting does not seem to
  take.
- **[Hosted and cloud Foundry](Hosting.md)** — The Forge, a droplet, or any
  server you do not control.
- **[Vault's own settings](https://kochitusker.github.io/Tusks-Vault/docs/surfaces/foundry-vtt/)** —
  the Foundry surface switch, and answering players.
