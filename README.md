# Tusk's Vault — Foundry VTT module

> ## ⚠️ This is a bridge. It is not the archivist.
>
> This module **does nothing on its own.** It is the Foundry half of a two-part
> system, and the half that actually holds your lore and talks to a model is a
> separate desktop app: **[Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault)**.
>
> **Install Tusk's Vault first, on the GM's own computer.** Then install this
> module so Foundry can reach it. Installing this module by itself gets you a
> chat command that has nothing to answer with.
>
> **Everything you need — what Vault is, how to install it, tutorials, provider
> setup, costs, privacy — lives here:**
> ### → **<https://kochitusker.github.io/Tusks-Vault/>**

---

## What it does, once both halves are in place

Ask your campaign's own lore from the Foundry chat bar:

```
/tusk who runs the harbour, and who do they answer to?
```

The answer comes back in chat, cited to **your** notes — the session logs, NPC
pages and setting documents you already keep — rather than to a model's guess
about a generic fantasy world.

## Two ways to run it

**Lite** answers from journal entries in this world, inside Foundry, with
nothing else installed. It is the front door — enough to see whether you like
the idea.

**Bridge** is what this module is for: the Foundry end of
[Tusk's Vault](https://kochitusker.github.io/Tusks-Vault/), which is free, and
is the full archivist.

| | Lite | Tusk's Vault |
|---|---|---|
| To install | Nothing | A free download |
| Where your lore lives | Journal entries you paste into one folder | The notes you already keep — Word documents, PDFs, Markdown, or a whole Obsidian vault |
| How much it can read | Only what fits into a single question | Everything you have |
| Finding the right note | Matches the words you typed | Works out what you meant |
| Paying for answers | Needs a Google API key | An API key, a Claude Code subscription you may already pay for, or a local model for nothing |
| Models | Gemini only | Claude, Gemini, Deepseek, Grok and 400+ more via OpenRouter |
| Your API key | Stored in your browser | Never touches a browser |
| Voice | One archivist | Personas you write yourself |
| When it does not know | Tells you, and forgets | Records the gap, and remembers your answer |
| Price | Free | Free, and open source |

Set it under **Module Settings → Where answers come from**.

### Where the lore comes from in the first place

Record your session and **[Tusk's Tomes](https://kochitusker.github.io/Tusks-Tomes/)**
turns the recording into a written chronicle and a session log. Those land in
the same folder Tusk's Vault reads — so by the next session the archive can
already answer questions about what just happened, without you writing a word
of it up. Tomes writes the history, Vault remembers it, and the table asks it
questions.

### Lite mode, in two layers

**Layer 1 — search. On by default, and needs nothing.** Put your notes in a
journal folder called **Tusk's Lore**, then `/tusk who runs the harbour?` finds
the passages and quotes them, cited to the entry they came from. No API key, no
network request, no cost.

Entries a player cannot open are never used to answer that player — lite reads
Foundry's own journal permissions, so a GM-only note stays GM-only even when a
player asks about it.

**Layer 2 — written answers. Off by default.** Turn on *Lite: write answers*
and set a **Gemini key** (Google's free tier is enough to try it). Lite then
writes prose with the same citation discipline, from the same journals.

Google's content filters are **off** by default, as they are in Tusk's Vault —
a campaign archive gets asked about war, murder and worse because that is what
your notes are about, and a filtered refusal reads as the archive not knowing.
*Lite: apply Google's content filters* turns them back on.

> ### ⚠️ What a key in the browser means
>
> The key is stored in **your browser only** — never in the world, so no player
> at your table can read it, and it is never sent to the Foundry server.
>
> But **Foundry does not sandbox modules.** Every other module you have
> installed runs on the same page and can read your browser's storage,
> including this key. Only install modules you trust.
>
> **Use a key made for this and nothing else, and set a spending cap on it** in
> Google's console. That turns the worst case from an open tab into a fixed
> number.
>
> Tusk's Vault keeps the key off the browser entirely. It is free, and this is
> the main reason to move up to it once you have decided you like this.

The same warning is shown in Foundry, in the dialog that takes the key — you
should not have to read a README to find it. The full picture is in
[SECURITY.md](SECURITY.md).

## The two parts, and which is which

|  | **Tusk's Vault** | **This module** |
|---|---|---|
| What it is | A local app on the GM's computer | A Foundry add-on module |
| What it holds | Your campaign documents, the model connection, the answers | Nothing |
| Where you get it | <https://kochitusker.github.io/Tusks-Vault/> | Foundry's *Install Module* |
| Who needs it | The GM only | The GM's world (players install nothing) |
| Can it run alone? | **Yes** — it also answers on Discord | **No** |

If you only install one of them, install Tusk's Vault. It is useful without
Foundry. This module is not useful without it.

## Requirements

1. **Tusk's Vault**, installed and running on the GM's computer, with the
   **Foundry VTT** surface switched on in its dashboard.
   → [Install guide](https://kochitusker.github.io/Tusks-Vault/)
2. **Foundry VTT v13 or newer.** Verified against v14.
3. A GM connected to the world. Questions are relayed through the GM's browser,
   so with no GM online there is nothing that can reach the archive.

## Installing this module

In Foundry: **Setup → Add-on Modules → Install Module**, then either search for
*Tusk's Vault* in the package list, or paste this into **Manifest URL**:

```
https://github.com/KochiTusker/Tusks-Vault-Foundry/releases/latest/download/module.json
```

Then, in your world: **Settings → Module Management** → tick **Tusk's Vault** →
*Save Module Settings*.

## Pairing with Vault

**Settings → Game Settings → Module Settings → Tusk's Vault → Connect to Tusk's
Vault.** Foundry shows a six-digit code and Vault's dashboard shows the same one
beside **Allow** / **Deny**. Check they match, then click Allow.

There is no token to copy. **If the codes do not match, click Deny** — something
other than Foundry asked to connect.

Full walkthrough, with screenshots:
**[kochitusker.github.io/Tusks-Vault](https://kochitusker.github.io/Tusks-Vault/)**

---

## Module settings

These are the module's own controls. Everything else — what Vault answers with,
which model it uses, what it costs, what leaves your machine — is a Vault
setting and is documented [on the docs site](https://kochitusker.github.io/Tusks-Vault/).

| Setting | Scope | What it does |
|---|---|---|
| **Enable in this world** | World | Turn the archivist off without uninstalling. |
| **Who may ask** | World | The lowest rank that may put a question. See below. |
| **Chosen askers** | World | Named people who may always ask, whatever their rank. |
| **Who sees the answer** | World | Where the answer is posted. Set separately from who may ask. |
| **Chat command** | World | Defaults to `/tusk`. |
| **Archivist name** | World | The name answers post under, and the `@mention` that also asks. |
| **Vault address** | Per browser | Leave blank to find Vault automatically. |

### Who may ask

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
player account, or a single loremaster at an otherwise closed table. Set the
rank to *Nobody by rank* and the list becomes the whole policy.

### Who sees the answer

| Setting | Who reads it |
|---|---|
| **The asker and the GM** *(default)* | Whispered to whoever asked, plus connected GMs. |
| **The GM only** | Whispered to GMs. The asker is told their question went to you. |
| **Everyone, in the open** | Posted to the chat log. |

### The spoiler trade-off, stated plainly

**Who sees the answer bounds visibility. It does not bound what a player can
pull.** The archive answers from your whole corpus and has no notion of what you
have revealed yet, so a player who asks about a sealed strongbox can be
whispered its contents. The whisper hides that from the rest of the table — not
from the player who asked.

If that matters at your table, restrict **Who may ask**, or set **Who sees the
answer** to *The GM only* so you read it first. Vault also has its own switch
("Answer players, not just the GM") that is off by default: with it off, player
questions are refused no matter what this module is set to.

---

## Security and privacy

Two pages, both written to be read before you trust this with a campaign:

- **[SECURITY.md](SECURITY.md)** — where credentials live and who can read
  them, what the module does to protect you, the limits that are real, and how
  to report a vulnerability.
- **[docs/Privacy.md](docs/Privacy.md)** — exactly what leaves your machine in
  each configuration, what is stored and where, and what is sent to this
  project (nothing).

**[What could actually go wrong](SECURITY.md#what-could-actually-go-wrong)** —
five plain scenarios with what each would cost you and what shrinks it. None
are likely; all are possible. The module is free software under the MIT
licence, which means it comes with no warranty and the authors are not liable:
your key, your Foundry server and the other modules you install are yours to
manage.

The three-line version:

- **Lite layer 1 is the default and sends nothing anywhere.** No key, no
  network request.
- **Secrets are stored per browser, never in the world.** Foundry hands world
  settings to every connected client, so a key kept there is a key your players
  can read.
- **Never put private files in the module's folder.** Foundry serves its data
  directory as unauthenticated static content, and replaces the folder on
  update.

## When something goes wrong

Press **F12** in the GM's browser and run:

```js
TusksVault.diagnostics()
```

That prints one block of text covering both questions a bug report has to
answer: what is configured, and what actually happened — as a timestamped log
with a stable code per failure. `TV-BRIDGE-401` is a rejected token,
`TV-BRIDGE-UNREACHABLE` is Vault not running. The same code appears in the chat
message, so you can quote it without transcribing anything.

**It is safe to paste into an issue.** No question text, answer text, bearer
token, world name or user id is recorded — only shapes, like a question's length
and how many people are on the allow list.

- **Module problems** (the chat command, pairing, settings) →
  [issues on this repo](https://github.com/KochiTusker/Tusks-Vault-Foundry/issues)
- **Everything else** (Vault won't start, answers are wrong, model setup, cost)
  → [the docs site](https://kochitusker.github.io/Tusks-Vault/) and the
  [Tusk's Vault repo](https://github.com/KochiTusker/Tusks-Vault)

## For developers

```bash
npm install
npm run verify     # the tests, plus the repository audits
npm run build      # writes dist-module/module.json and module.zip
```

There is no CI that can run Foundry, so `test/module-runtime.test.mjs` drives
both chat hooks end to end against stubs of the Foundry globals the module
touches. That is not a claim the module works in Foundry — only that its logic
does what it says against Foundry's documented contracts.

- [`docs/DocsLinks.md`](docs/DocsLinks.md) — the documentation URLs this module
  hard-codes, and what has to exist at each of them.
- [`RELEASING.md`](RELEASING.md) — how a version reaches Foundry's package
  registry.
- The wire protocol between this module and Vault is specified on the Vault side,
  in `docs/tooling/foundry-contract.md`. A change to it is a change to both repositories.

## Licence

MIT. The app this bridges to, and all of its documentation:
**<https://kochitusker.github.io/Tusks-Vault/>**
