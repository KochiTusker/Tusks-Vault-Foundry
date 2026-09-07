# Security

This module reads your campaign notes and, in one configuration, holds a
credential that can be spent. This page says what it protects, what it cannot,
and how to report a problem.

It is about protecting **you**. Where a limit is real it is stated plainly
rather than softened — a security page that only lists reassurances is not one.

---

## Report a vulnerability

Use **[GitHub's private security advisories](https://github.com/KochiTusker/Tusks-Vault-Foundry/security/advisories/new)**
on this repository. That reaches the maintainer without the report being public
while it is being fixed.

Please do not open a public issue for a vulnerability. For anything that is not
a vulnerability, the ordinary
[issue tracker](https://github.com/KochiTusker/Tusks-Vault-Foundry/issues) is right.

If you would rather not use GitHub, say so in an issue without details and a
private channel will be arranged.

---

## The two configurations have different exposure

| | **Bridge** (Tusk's Vault) | **Lite, layer 1** | **Lite, layer 2** |
|---|---|---|---|
| Credential in the browser | A pairing token | None | **Your Gemini key** |
| Leaves your machine | Questions, to Vault on your own machine | **Nothing** | Question + selected notes, to Google |
| Model provider key | Held by Vault, never in a browser | — | In your browser |

**Layer 1 is the default.** A fresh install holds no credential and makes no
external request. Everything below about keys applies only once you turn on
lite answers or pair with Vault.

---

## Credentials

The module stores two secrets, in two situations, and both follow the same two
rules.

| Setting | When | Scope |
|---|---|---|
| `bridgeToken` | Minted when you pair with Tusk's Vault | `client` |
| `geminiKey` | Typed by you, for lite answers | `client` |

**Both are `client` scope, and neither is ever rendered into a settings form.**

Scope is the important one. Foundry distributes **world**-scoped settings to
every connected client — that is how a setting takes effect for players at all
— so a secret stored in world scope is a secret every player at your table can
read out of `game.settings`. For the bridge token that would let them query
your campaign directly and ignore your access policy. For a provider key it
would let them spend your money.

Client scope means the value lives in that one browser's storage. It is not in
the world database, is never sent to the Foundry server, and no other player
can read it.

Neither appears in `TusksVault.diagnostics()`. That output is written to be
pasted into a public issue tracker, so it records **shapes** — a key's length,
a question's length, how many people are on an allow list — and never values.

### What can still read a key in your browser

Stated plainly, because it is the real limit:

- **Every other Foundry module you have installed.** Foundry does not sandbox
  modules. They all run on the same page, with the same access to that page's
  storage. Only install modules you trust.
- **Anyone with access to your computer**, at the level of your browser profile.

And what cannot: your players, anyone on your network, anyone who can reach
your Foundry server, and Foundry itself.

### If you use lite answers

- Create a key **for this and nothing else**, and set a spending cap on it in
  Google's console. That turns the worst case from an open tab into a fixed
  number.
- Revoke that key if you stop using lite mode, or if you install a module you
  later have doubts about.
- **Tusk's Vault keeps the key off the browser entirely.** It is free. If the
  above makes you uncomfortable, that is the fix rather than a compromise.

---

## Never put private files in the module's folder

Anything under Foundry's data directory is served as **static, unauthenticated
content**. A file placed in `Data/modules/tusks-vault/` can be fetched by
anyone who can reach your Foundry server, with no login — and if you expose
Foundry through a tunnel or a hosting service, that means anyone on the
internet.

This is why lite mode reads **journal entries** rather than files. Journals live
in the world database, behind Foundry's own permissions.

It is also why the module folder is the wrong place for a key, a `.env`, or
private campaign notes. Foundry additionally replaces that folder when the
module updates, so anything you put there is deleted without warning.

---

## What the module does to protect you

**Answers are escaped before they reach the chat log.** An answer is model
output assembled from your own documents, and it renders on every client at the
table. The text is escaped once, first, and only tags the module itself adds
are ever present — so stray markup in a lore note cannot become script running
on a player's machine.

**Identity comes from Foundry, never from the message.** A player can set
arbitrary flags on a message they create, so the module derives who asked from
the chat document's server-side `author` field. A flag claiming `isGM` proves
nothing and is not consulted.

**Exactly one client relays.** `game.users.activeGM` elects a single GM client
to reach the archive, so a question is answered — and billed — once, not once
per connected GM.

**Only a GM's browser talks to a provider or to Vault.** A player's client
posts a chat document and nothing else. It holds no credential and makes no
external request.

**Lite filters the corpus by what the asker may open.** Journal entries carry
Foundry's ownership, so a GM-only note is not used to answer a player, even
when it would have matched. This is per-player lore scoping, and it applies to
both lite layers.

---

## What could actually go wrong

Plain scenarios rather than categories, because "there is a residual risk" tells
nobody anything. None of these are likely. All of them are possible, and you can
decide what to do about each.

### A module you installed steals your Gemini key

**How.** Foundry does not sandbox modules. Every module you install runs on the
same page with the same access to browser storage. A malicious or compromised
one could read the key and send it anywhere.

**What it costs you.** Whatever that key can spend, until you notice and revoke
it. If the key belongs to a Google account with other things attached, it may
reach those too.

**What shrinks it.** Use a key created for this and nothing else, with a
spending cap set in Google's console — that turns an open tab into a fixed
number. Install fewer modules, from authors you have reason to trust. Or run
Tusk's Vault, where the key never enters a browser at all.

### Your campaign leaks because Foundry is on the open internet

**How.** Foundry serves its data directory as unauthenticated static content.
If you expose Foundry through a tunnel or a host, anything in that directory is
reachable by anyone who finds the address.

**What it costs you.** Your notes, if you put them somewhere Foundry serves.

**What shrinks it.** Keep lore in journal entries, which live in the world
database behind Foundry's permissions — which is what this module does. Never
put private files in a module folder. Do not expose Foundry more widely than
you need.

### A player reads lore you had not revealed

**How.** In bridge mode the archive answers from your whole corpus and has no
notion of what the party has discovered. A player asking a pointed question can
be told something you were saving.

**What it costs you.** A spoiled reveal — the most likely thing on this page to
actually happen to you.

**What shrinks it.** Restrict **Who may ask**, or set **Who sees the answer** to
*The GM only*. In lite mode this is already handled: journal permissions are
enforced per asker.

### The model says something wrong, and it looks sourced

**How.** Answers are generated. The citation rules make invention much harder
and a claim without a citation is visible as such, but a model can still
misread a note or attach the wrong source.

**What it costs you.** A wrong ruling at the table, stated confidently.

**What shrinks it.** The citations are clickable for a reason. Check the source
when a claim matters.

### A question or your notes reach a provider you did not expect

**How.** In lite layer 2 your question and the selected journal text go to
Google. In bridge mode Vault sends to whichever provider you configured there.

**What it costs you.** Your campaign text sits in a third party's logs under
whatever terms that account has.

**What shrinks it.** [docs/Privacy.md](docs/Privacy.md) lists every destination
and when each is contacted. Lite layer 1 contacts nothing at all. Vault can run
a local model, in which case nothing leaves your machine.

---

## Risk, and whose it is

This is free software given away under the MIT licence. That licence is the
operative statement, and it is short and worth reading: the software is
provided **"as is", without warranty of any kind**, and the authors are **not
liable** for any claim, damages or other liability arising from it. See
[LICENSE](LICENSE).

In practice that means the things only you control are yours:

- **Your API key** — creating it, capping its spend, revoking it, and deciding
  whether a browser is an acceptable place for it.
- **Your Foundry server** — who can reach it, and whether it is on the
  internet.
- **The other modules you install** — this one cannot protect a key from them,
  and does not claim to.
- **What you keep in your world** — and who at your table can read it.

What is ours: telling you the truth about how it works, keeping secrets out of
world settings and out of diagnostics, and fixing what is reported. If you find
something wrong, the advisory link at the top is the fastest way to reach us.

Nothing here is a substitute for reading the licence, and none of it is legal
advice.

## Known limits

**Whispering bounds who SEES an answer, not what a player can pull.** In bridge
mode the archive answers from your whole corpus and has no notion of what you
have revealed yet, so a player who asks about a sealed strongbox can be
whispered its contents. The whisper hides that from the rest of the table, not
from the person who asked. Use **Who may ask** to restrict it, or set **Who
sees the answer** to *The GM only* so you read it first. Tusk's Vault has its
own switch for answering players at all, off by default.

Lite mode does not have this limitation, because journals carry permissions.

**A key in a browser is reachable by anything else in that browser.** Covered
above. It is the reason layer 1 is the default and layer 2 is opt-in.

**Foundry does not sandbox modules.** Nothing this module does can change that.

**A shared computer is a shared browser.** Client-scope storage protects a
credential from your players, not from someone sitting at your machine.

---

## Supported versions

Security fixes are made against the most recent release. This module declares
Foundry v13 as its minimum and is verified against v14.

## Scope

Vulnerabilities in **Tusk's Vault** itself — the desktop application this
module bridges to — belong in
[its own repository](https://github.com/KochiTusker/Tusks-Vault). This page
covers the Foundry module.
