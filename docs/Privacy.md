# What leaves your machine

This module reads your campaign notes and can send them to a model provider.
This page says exactly what goes where, in each configuration, so you can
decide rather than assume.

[SECURITY.md](../SECURITY.md) covers credentials and threats. This page is only
about data flow.

---

## Lite, layer 1 — searching

**Nothing leaves your machine. There is no network request at all.**

The module reads journal entries from the folders you point it at, ranks them
against your question in the browser, and posts the matching passages to chat.
No provider, no key, no request. This is the default a fresh install runs in.

---

## Lite, layer 2 — written answers

```
your question  ─┐
                ├─►  the GM's browser  ──TLS──►  Google (Gemini)
journal text   ─┘         (your key)
```

When you turn on *Lite: write answers* and set a Gemini key:

**What is sent:** your question, and the text of journal pages from your lore
folders — as many as fit the size cap, best matches first. Each is labelled with
its page name so the model can cite it.

**What is not sent:** anything outside the lore folders, your world name, your
players' names, and your Foundry address. The asker's identity is not sent
either. If you have switched on per-player scoping, pages the person asking
cannot open are not sent for their questions.

**Where it goes:** from the GM's browser straight to Google's API over TLS.
There is no intermediate server, and nothing passes through the maintainer's
hands or any service belonging to this project.

**Content filters are off by default.** The request asks Gemini not to apply
its standard safety thresholds, because a campaign archive is asked about war,
murder and worse — that being what the notes are about — and a filtered refusal
reads to a GM as the archive not knowing rather than declining. Tusk's Vault
makes the same choice. *Lite: apply Google's content filters* turns them on if
your table wants them; remember answers land in a chat log everyone reads.

**What Google does with it** is governed by the terms of the account whose key
you used. Free-tier and paid Gemini terms differ on whether data may be used to
improve their models — check which applies to you before pointing this at a
campaign you consider private.

---

## Bridge — Tusk's Vault

```
player asks  ──►  chat document  ──►  the GM's browser  ──►  Vault
                  (your world DB)                      (127.0.0.1, your machine)
                                                              │
                                                              ▼
                                                   whichever provider you
                                                     configured in Vault
```

**Your lore never leaves your own machine as a corpus.** Vault runs locally and
holds the documents. What leaves is a question, plus whatever context Vault
chooses to include, sent to the model provider *you* configured there — which
may be a local model, in which case nothing leaves at all.

The module itself only ever talks to `127.0.0.1`. It has no other outbound
destination.

Vault's own privacy documentation covers what it sends onward:
[kochitusker.github.io/Tusks-Vault](https://kochitusker.github.io/Tusks-Vault/)

---

## What is stored, and where

| Thing | Where it lives | Who can read it |
|---|---|---|
| Questions and answers | Chat messages in your world database | Whoever the message was whispered to |
| Your lore | Journal entries in your world | Per Foundry's journal ownership |
| Table policy (who may ask, and so on) | World settings | Every connected client |
| Vault address, pairing token | That browser's storage | That browser only |
| Gemini key | That browser's storage | That browser only |
| Diagnostics | Memory, capped, cleared on reload | Whoever runs the command |

Questions and answers are ordinary chat messages. They persist in your world
and appear in exports and backups like any other message. Delete them as you
would any chat message.

---

## Diagnostics are safe to paste

`TusksVault.diagnostics()` is written to be pasted into a public issue tracker.
Wherever a value would identify you or your table, it records **the shape
instead**:

- a question's length, never its text
- a key's length, never the key
- how many people may ask, never who
- whether the Vault address is loopback, never a hand-set hostname
- which stage failed, and a stable code for it

It contains no question text, no answer text, no token, no world name, no
player names and no user ids. File paths and cloud project numbers are stripped
out of any error it records, and long errors are truncated.

**Two things it does quote**, because a report is unreadable without them:

- the names you chose — the trigger command, the bot, the lore folder
- error text from Tusk's Vault or from your model provider, as those programs
  wrote it

Neither is filtered beyond the stripping above, because neither is this
module's text to rewrite. If your campaign's name is in one of them, that is
the line to check before pasting.

---

## The exact destinations

The module can make outbound requests to these hosts and no others. If you
audit your network, this is the complete list:

| Host | When | What for |
|---|---|---|
| `127.0.0.1` (ports 3000–3019) | Bridge mode only | Finding and talking to Tusk's Vault on your own machine. Never leaves the machine. |
| `generativelanguage.googleapis.com` | Lite layer 2 only | Your question and the selected journal text, and listing which models your key can use. |
| `kochitusker.github.io` | Never automatically | A link the module renders on lite answers and on the upgrade, FAQ and About screens. Your browser contacts it only if you click it. |
| `github.com` | Never automatically | The same, for the source repository. Only contacted if you click it. |
| `buymeacoffee.com` | Never automatically | A link on the **About** screen, for anyone who goes looking for a way to support the project. Nothing renders it anywhere else, and your browser contacts it only if you click it. |

Lite layer 1 contacts nothing. A fresh install, before you pair or set a key,
contacts nothing.

A test in this repository fails if a hostname appears in the module's code
without appearing in this table, so the list cannot quietly grow.

## Nothing is sent to this project

The module has no telemetry, no analytics, no crash reporting and no update
ping of its own. It contacts exactly two kinds of destination, both of which
you choose: `127.0.0.1` for Tusk's Vault, and Google's API if you have turned
on lite answers and supplied a key.

Foundry checks for module updates against Foundry's own package registry, which
is Foundry's behaviour rather than this module's.
