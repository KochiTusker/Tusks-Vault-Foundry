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

**Lite can filter the corpus by what the asker may open, page by page.** Journal
pages carry their own Foundry ownership, and *Lite: what each answer may draw on*
can read it, so a GM-only page is not used to answer a player even when it sits
inside an entry that player can read.

**This is opt-in, and the default reads the whole folder.** Foundry creates every
journal entry with no player access at all, so filtering by ownership out of the
box answers "I could not find anything" to every player question until the GM has
set permissions on every entry. On the default, **the folder is the boundary**:
what you put in it is what the archivist may say to anyone allowed to ask.

The ownership check is made page by page, so a restricted page inside a shared
entry is not used to answer someone who cannot open it.

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

**Whose problem this is.** Foundry's, not this module's. It applies identically
to every exposed Foundry server with no modules installed at all, and nothing
here makes it likelier or worse. It is listed because it affects what you should
keep in your world, not because this module introduces it.

**How.** Foundry serves its data directory as unauthenticated static content.
If you expose Foundry through a tunnel or a host, anything in that directory is
reachable by anyone who finds the address. Separately, Foundry serves plain
**HTTP** by default — so a self-hosted server on a forwarded port is
unencrypted, and its join and admin passwords cross the wire in clear text,
unless you give Foundry a certificate or put it behind a tunnel or proxy. A
managed host does this for you.

**What it costs you.** Your notes, if you put them somewhere Foundry serves.

**What shrinks it.** All of it is Foundry-side and documented by Foundry
([hosting](https://foundryvtt.com/article/hosting/),
[SSL](https://foundryvtt.com/article/ssl/)): serve over HTTPS if you are
reachable from the internet, and do not expose Foundry more widely than you
need. On this module's side, keep lore in journal entries, which live in the
world database behind Foundry's permissions — which is what it does — and never
put private files in a module folder. See
[docs/Hosting.md](docs/Hosting.md#part-two-foundrys-own-security-which-this-module-does-not-change).

### A player reads lore you had not revealed

**How.** In bridge mode the archive answers from your whole corpus and has no
notion of what the party has discovered. A player asking a pointed question can
be told something you were saving.

**What it costs you.** A spoiled reveal — the most likely thing on this page to
actually happen to you.

**What shrinks it.** Restrict **Who may ask**, or set **Who sees the answer** to
*The GM only*. In lite mode, keep unrevealed notes out of the lore folder until
the party earns them — or switch on the experimental per-player scope, which
enforces journal permissions per asker.

### A player plants a note that tells the archivist what to do

**How.** Journal folders are not a permission boundary in Foundry, so anyone
allowed to create a journal entry can put one in your lore folder. Text in that
folder is not merely quoted back — it goes **into the prompt**, next to the
archivist's own instructions. Somebody who can write a note can therefore write
instructions to the model.

**What it costs you on the default scope.** Potentially the folder. Every
question is answered from everything in it whoever asked, so a note a player can
edit sits in a prompt beside lore they cannot read, and can ask for it.

**What it costs you under *per-player* scoping.** Very little, and this is worth
being precise about. The corpus assembled for a player then contains only
material that player could already open, so a planted note can influence answers
to its own author, drawn from their own notes. There is nothing there to steal.

**What it costs you under *what every player can open*.** More than the sentence
above used to admit. That mode is scoping, but it is not per-player: one corpus
is built from what the whole table shares, and it is used for **everyone's**
questions. A page every player can read is exactly the kind a player is likely
to have been granted ownership of — so a note planted there reaches every
asker's answer, not just its author's. Containment by construction is a property
of the per-player mode alone. The module warns about an editable page under this
mode too, which until 1.1.1 it did not.

**What shrinks it.** Keep notes players can edit **out of the lore folder** —
the module warns you when it finds one in there, naming how many. Or switch
*Lite: what each answer may draw on* to the per-player mode, where the problem
does not arise. Check who can edit what with *Lite: review lore permissions*, and
remember Foundry grants journal creation to Trusted Player and above by default.

**What is already handled.** A planted note cannot run script at your table: an
answer is escaped once before it reaches the chat log, and only tags the module
itself adds are ever present. And a citation naming a document that was not in
the prompt is rendered as unverified rather than as a source, so an invented
reference does not look like a real one.

### A player at your table spends your Gemini key

**How it happens.** Lite answers are paid for by whoever set the key, and asked
for by whoever may ask. A player types a question, the active GM's browser
assembles the lore and calls Google with the GM's own key. That is the right
shape — the key never leaves the one browser holding it — but it does mean the
person asking and the person paying are not the same person. Someone doing it on
purpose does not even have to type: a message carries the question as a field,
and a browser console can create messages in a loop.

**What it costs you.** Money, and your table's answers for the rest of the
session once the quota is gone. Not your notes: this spends the key, it does not
read anything the asker could not already ask for.

**What shrinks it.** The module now bounds it. A question is capped in length,
and each person may have exactly one question in the air at a time — nobody can
ask a second before the first comes back, so a burst of five hundred messages
produces one request and four hundred and ninety-nine refusals. What remains is
bounded by how long Google takes to answer rather than by how fast somebody can
type, and every question is a visible chat message.

**What the module cannot do.** Set a spending limit in money. It cannot see
prices, and a cap it could not enforce honestly would be worse than none. **Set
a budget cap in the Google Cloud console** — that is the backstop, and it is the
only hard limit that exists. *Who may ask* is the other lever: a table that has
had trouble can move it off **Everyone**.

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

**The guard against publishing private notes applies only under per-player
scoping.** In that mode, an answer drawing on pages not every player can read is
whispered to the asker and the GMs rather than posted, even when *Who sees the
answer* says everyone — otherwise per-asker retrieval and public replies would
cancel each other out. On the default scope there is no per-asker retrieval to
protect, so both settings are honoured exactly as you set them.

**Whispering bounds who SEES an answer, not what a player can pull.** A player
who asks about a sealed strongbox can be whispered its contents; the whisper
hides that from the rest of the table, not from the person who asked. The three
ways to close it are settings, so they are documented with the settings:
[the spoiler trade-off](docs/Settings.md#the-spoiler-trade-off).

Lite mode has this limitation on its default scope, which reads the whole lore
folder whoever asks — the folder is the boundary, so keep unrevealed material out
of it. The experimental per-player scope closes it, because journal pages carry
permissions.

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
