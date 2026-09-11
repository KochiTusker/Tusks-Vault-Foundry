# Tusk's Vault — for Foundry VTT

Ask your campaign's own lore from the chat bar, and get an answer cited to your
own notes.

```
/tusk who runs the harbour, and who do they answer to?
```

Not a model's guess about a generic fantasy world — your session logs, your NPC
pages, your setting documents. Players install nothing.

---

## Two ways to run it

**Lite** works the moment you enable this module. It answers from journal
entries in your world — the folders you point it at — and needs nothing else
installed.

**Bridge** connects Foundry to
**[Tusk's Vault](https://kochitusker.github.io/Tusks-Vault/)** — a free app you
run on your own computer that reads the notes you already keep. It is the full
archivist, and this module is its Foundry end.

Pick under **Module Settings → Where answers come from**. Start with Lite; move
up when you want more.

## Install

**Setup → Add-on Modules → Install Module**, then search for *Tusk's Vault*, or
paste this into **Manifest URL**:

```
https://github.com/KochiTusker/Tusks-Vault-Foundry/releases/latest/download/module.json
```

Then in your world: **Settings → Module Management** → tick **Tusk's Vault** →
*Save Module Settings*.

Needs **Foundry v13 or newer** (verified against v14) and a GM connected —
questions are relayed through the GM's browser.

## Start with Lite, in about two minutes

1. Make a journal folder called **Tusk's Lore**.
2. Put notes in it — paste in what you already have, or write as you go.
3. Ask: `/tusk who runs the harbour?`

That is the whole setup. **No account, no API key, no network request, no cost.**

What you get for that:

- **Answers cited to the page they came from** — and the citation is a link, so
  one click opens the journal at that page rather than making you hunt for it.
- **The folder is the boundary.** Tusk answers from everything in your lore
  folders and nothing outside them, so what you put in decides what it may say.
  Keep a reveal out until the party earns it.
- **Optionally, per-player answers.** Turn on the experimental scope and Tusk
  reads Foundry's journal ownership page by page instead: two players asking the
  same question are answered from the notes each of them can actually open, and
  a player's own backstory answers them and nobody else.
- **Control over who may ask and who sees the reply** — a rank, plus named
  exceptions, and answers whispered or posted as you choose.
- **`@Tusk` works too**, if you would rather mention the archivist than type a
  command. Both the command and the name are yours to rename.

Optionally, add a **Gemini key** and turn on *Lite: write answers* — the same
journals, the same citations, but written as prose instead of quoted passages.
Google's free tier is enough to try it.

> **A key kept in a browser is readable by every other module you install.**
> Foundry does not sandbox modules. Use a key made for this and nothing else,
> and set a spending cap on it. Tusk's Vault keeps keys off the browser
> entirely — it is free, and that is the main reason to move up once you have
> decided you like this.

**→ [Lite mode in full](docs/Lite.md)** — the two layers, the folder, the key,
the content filters, and what Lite genuinely cannot do.

## What moving up to Tusk's Vault gets you

Lite reads journal folders inside Foundry and can only hold as much as fits in a
single question. Vault reads everything you have.

| | **Lite** *(this module alone)* | **Tusk's Vault** |
|---|---|---|
| To install | Nothing | A free download |
| Where your lore lives | Journal entries, in the folders you choose | The notes you already keep — Word, PDF, Markdown, or a whole Obsidian vault |
| How much it can read | Only what fits in one question | Everything you have |
| Finding the right note | Matches the words you typed | Works out what you meant |
| Paying for answers | A Google API key | A key, a Claude Code subscription you may already pay for, or a local model for nothing |
| Models | Gemini only | Claude, Gemini, Deepseek, Grok and 400+ more |
| Your API key | Stored in your browser | Never touches a browser |
| **Per-player answers** | **Optional: each person answered from the notes they can open, including ones they wrote themselves** | Answers from the whole archive; Foundry's permissions are invisible to it |
| Voice | One archivist | Personas you write yourself |
| When it does not know | Tells you, and forgets | Records the gap, and remembers your answer |
| Also answers on | — | Discord |
| Price | Free | Free, and open source |

Vault is useful without Foundry; this module is not useful without Vault. If you
only ever install one, install Vault.

- **[What Tusk's Vault is](https://kochitusker.github.io/Tusks-Vault/)** ·
  **[Install it](https://kochitusker.github.io/Tusks-Vault/docs/getting-started/installation/)** ·
  **[Pick a model](https://kochitusker.github.io/Tusks-Vault/docs/getting-started/choosing-a-provider/)** ·
  **[What it costs](https://kochitusker.github.io/Tusks-Vault/docs/about/what-it-costs/)**
- **[Where the lore comes from](https://kochitusker.github.io/Tusks-Vault/docs/lore/obsidian-vault/)** —
  point it at notes you already have.
- **[Tusk's Tomes](https://kochitusker.github.io/Tusks-Tomes/)** turns a session
  recording into a written chronicle, into the same folder Vault reads. Tomes
  writes the history, Vault remembers it, your table asks it questions.

## Connecting to Tusk's Vault

With Vault installed and running: **Module Settings → Tusk's Vault → Connect to
Tusk's Vault**. Foundry shows a six-digit code; Vault's dashboard shows the same
code beside **Allow** and **Deny**. Check they match, then click Allow.

There is no token to copy. **If the codes do not match, click Deny** — something
other than Foundry asked to connect.

**→ [Full walkthrough, with screenshots](https://kochitusker.github.io/Tusks-Vault/docs/surfaces/foundry-vtt/)**

## Everything else

| | |
|---|---|
| **[Settings](docs/Settings.md)** | Every module setting: who may ask, who sees the answer, and the spoiler trade-off worth knowing about. |
| **[Lite mode](docs/Lite.md)** | The standalone half in full. |
| **[Troubleshooting](docs/Troubleshooting.md)** | When it does not answer, and how to file a useful bug report. |
| **[Hosted Foundry](docs/Hosting.md)** | The Forge, a droplet, or any server you do not control — both halves work, and this says how. |
| **[SECURITY.md](SECURITY.md)** | Where credentials live, who can read them, and what could actually go wrong. |
| **[docs/Privacy.md](docs/Privacy.md)** | Exactly what leaves your machine in each configuration. Nothing is ever sent to this project. |
| **[Development](docs/Development.md)** | Building, testing and releasing this module. |

Anything about Vault itself — models, costs, providers, what it does with your
documents — lives on
**[the documentation site](https://kochitusker.github.io/Tusks-Vault/)**, not
here.

The three things worth knowing before you trust this with a campaign:

- **Lite's search layer is the default and sends nothing anywhere.** No key, no
  network request.
- **Secrets are stored per browser, never in the world.** Foundry hands world
  settings to every connected client, so a key kept there is a key your players
  can read.
- **Never put private files in the module's folder.** Foundry serves its data
  directory as unauthenticated static content, and replaces the folder on
  update.

## Licence

MIT — no warranty, and your Foundry server, your API key and the other modules
you install are yours to manage.
