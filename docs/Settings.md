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
| **Lite: lore folder** | World | Which journal folder Lite reads. Defaults to *Tusk's Lore*. |
| **Lite: write answers** | World | Prose answers instead of quoted passages. Needs a key. |
| **Lite: model** | World | Which Gemini model writes them. |
| **Lite: apply Google's content filters** | World | Off by default. [Why.](Lite.md#content-filters-are-off-by-default) |
| **Gemini key** | Per browser | Never stored in the world. [What that means.](Lite.md#what-a-key-in-the-browser-means) |

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

**Lite does not have this problem**, because it reads Foundry's own journal
permissions per asker: an entry a player cannot open is never used to answer
them. See [Lite mode](Lite.md#players-only-ever-see-what-they-could-already-read).

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
- **[Vault's own settings](https://kochitusker.github.io/Tusks-Vault/docs/surfaces/foundry-vtt/)** —
  the Foundry surface switch, and answering players.
