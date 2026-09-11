# When something goes wrong

Start here, whatever the symptom. One command answers both questions a bug
report has to answer — what is configured, and what actually happened.

Open **Settings → Module Settings → Tusk's Vault → About** and press
**Copy diagnostics**. Or, if you would rather use the console, press **F12** and
run:

```js
TusksVault.diagnostics()
```

**It is safe to paste into a public issue.** No question text, no answer text, no
bearer token, no world name, no user id, and no hand-set address is recorded —
only shapes, like a question's length and how many people are on the allow list.

---

## The codes

Every failure carries a stable code, and the same code appears in the chat
message — so you can quote it without transcribing anything.

| Code | What it means | What fixes it |
|---|---|---|
| `TV-BRIDGE-UNREACHABLE` | Nothing answered at Vault's address. | Start Tusk's Vault. If it is running, check [the address](Settings.md#the-vault-address). |
| `TV-BRIDGE-401` | Vault rejected the credential. | Pair again. |
| `TV-BRIDGE-403` | Valid credential, refused. | Usually a changed Foundry address — [pair again from the address you now use](Settings.md#the-vault-address). Or the Foundry surface is off in Vault. |
| `TV-BRIDGE-404` | The session lapsed. | Recovers by itself; if it persists, pair again. |
| `TV-BRIDGE-TIMEOUT` | Vault took too long to answer. | A large corpus or a slow provider. Check Vault's own logs. |
| `TV-DISCOVER-NONE` | No Vault found on ports 3000–3019. | Start it, or set the address by hand. |
| `TV-ASK-REFUSED` | The asker is below your access policy. | [Who may ask](Settings.md#who-may-ask). |
| `TV-LITE-NOKEY-HERE` | Written answers are on, but this browser holds no key. | Set the key in the GM's browser — [it is per browser](Lite.md#what-a-key-in-the-browser-means). |
| `TV-LITE-MODEL-MOVED` | Google retired the model; a replacement was chosen. | Nothing. It already fixed itself. |
| `TV-LITE-CORPUS-CAPPED` | Your lore did not fit into one question. | Nothing breaks — the best match is still read, cut short if it must be. The answer says how many notes it read. Vault indexes instead of stuffing a prompt. |
| `TV-LITE-SCOPE-WIDE` | Answers draw on everything you can open, **and** players can create journals. | [Narrow the scope](Settings.md#what-each-answer-may-draw-on), or take journal-creation off your players. |
| `TV-ANSWER-NARROWED` | A public answer was whispered instead, because it used notes not everyone can read. | Nothing. That is the guard working. |
| `TV-DISCOVER-NONE` on a hosted Foundry | Vault was not found from your browser. | Vault runs on **your** computer, not the server — see [hosted Foundry](Hosting.md#bridge-on-a-host-you-do-not-control). Safari blocks this; use Chrome or Firefox. |
| `TV-LITE-403`/`429` | Google refused the key, or you are over quota. | The message is Google's own wording, which names the fix. |

## Common symptoms

### Foundry says the command is not valid

The module did not load, or the command was renamed. Run `TusksVault.selfTest()`
— if it is not defined at all, the module is not active. If it is,
`parsesConfiguredCommand` and `parsesLiteralSlashTusk` tell a rename apart from a
fault.

### Nothing happens, or the question just sits there

Questions are relayed through the **elected GM's browser**. With no GM connected
there is nothing that can answer. Check a GM is online and that
`TusksVault.selfTest()` reports `enabled: true`.

### Lite answers "I could not find anything"

Lite reads the journal folders you point it at, everything nested inside them
included, and matches the words you typed. Run `TusksVault.lore()`: it lists
every page Lite can actually see. An empty list means your notes are in the wrong folder; see [the
folder](Lite.md#the-folder).

If the list looks right, the problem is almost certainly the wording. **Lite
matches your words letter for letter and has no notion of what they mean**, so:

- **`harbours` does not find `harbour`.** There is no stemming — a plural, a
  past tense or an `-ing` will miss.
- **`wharf`, `quayside` and `dockmaster` do not find `harbour master`.** There
  are no synonyms.
- **Short words match inside longer ones.** Asking about a `war` also matches
  `dockwarden`, so a three-letter word can pull up something unrelated.

Ask using the words your notes actually use. This is [the main thing Vault does
differently](Lite.md#what-lite-cannot-do) — it works out what you meant, so it
still finds the page when you word it another way.

### A player got an answer they should not have

In **Bridge** mode the archive answers from your whole corpus and does not know
what you have revealed. Read [the spoiler
trade-off](Settings.md#the-spoiler-trade-off) — there are three ways to close it,
and one of them is a Vault setting.

In **Lite** mode, check the scope first. On the default it reads your whole lore
folder whoever asks, so this is expected — see [what each answer may draw
on](Settings.md#what-each-answer-may-draw-on). Under the per-player scope it
should not happen: run *Lite: review lore permissions* to confirm the page really
is restricted, and if it is, please report it.

### It worked yesterday and now returns 403

Almost always a changed Foundry address. A credential is bound to the exact
`scheme://host:port` you paired from, so moving from `localhost` to a LAN IP, or
putting Foundry behind HTTPS, correctly invalidates it. Pair again from the
address you now use.

## Where to report it

- **This module** — the chat command, pairing, settings, Lite →
  [issues on this repository](https://github.com/KochiTusker/Tusks-Vault-Foundry/issues)
- **Tusk's Vault** — it will not start, answers are wrong, model or provider
  setup, cost →
  [the FAQ](https://kochitusker.github.io/Tusks-Vault/docs/troubleshooting/faq/),
  [known issues](https://kochitusker.github.io/Tusks-Vault/docs/troubleshooting/known-issues/),
  or [the Vault repository](https://github.com/KochiTusker/Tusks-Vault)
- **A security problem** — please do not open a public issue.
  [How to report it privately](../SECURITY.md).

Paste the output of `TusksVault.diagnostics()` into any report about this
module. It is written to be safe to share, and it saves a round trip.
