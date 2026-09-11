# Hosted and cloud Foundry

**Both halves of this module work on a hosted Foundry.** The Forge, Molten
Hosting, a droplet, a friend's server — it makes no difference to Lite, and
Bridge works too, for a reason worth understanding before you assume it cannot.

This page answers two separate questions, and it is worth not mixing them up:

1. **[What does this module need from my hosting?](#part-one-what-this-module-needs)**
   Short answer: very little.
2. **[What does exposing Foundry to the internet mean?](#part-two-foundrys-own-security-which-this-module-does-not-change)**
   That is a Foundry question, not a Tusk's Vault question. It has the same
   answer whether or not this module is installed, and the second half of this
   page is here so you can make an informed choice — not because anything here
   introduces it.

---

# Part one: what this module needs

## Lite

Nothing to think about. Lite reads journal entries out of your world and runs
entirely inside the browser. Where the Foundry server lives is irrelevant.

If you turn on written answers, the request goes from **the GM's browser**
straight to Google. It does not pass through your Foundry host, and your host
never sees the key.

## Bridge, on a host you do not control

This is the part people assume is impossible, and it is not.

Tusk's Vault runs on **the machine you play from**, not on the Foundry server.
The module looks for it at `http://127.0.0.1:3000-3019` — and that lookup
happens in **your browser**, so it reaches *your own computer*. Your Foundry
host is never involved and never needs to be able to see Vault.

```
your laptop                                  your host
┌───────────────────────────────┐            ┌──────────────┐
│  browser ──HTTPS──────────────┼───────────►│   Foundry    │
│     │                         │            └──────────────┘
│     └──http://127.0.0.1:3000──► Tusk's Vault
│        (never leaves this machine)         │
└───────────────────────────────┘
```

So the requirements are:

1. **Run Vault on the computer you open Foundry from.** If you GM from a laptop,
   Vault goes on the laptop.
2. **Be the GM relaying.** Questions are answered by the elected GM's browser,
   which is the one that can reach Vault. Your players need nothing, install
   nothing, and are not affected by any of this.
3. **Pair from the address you actually use.** A credential is bound to the
   exact `scheme://host:port` you paired from, so pair while you are at
   `https://yourgame.forge-vtt.com`, not at `http://localhost:30000`.

### Why the browser allows this

Your hosted Foundry is served over HTTPS and Vault is plain HTTP on loopback,
which looks like the mixed content browsers block. It is not: `http://127.0.0.1`
is a [potentially trustworthy origin](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content)
and is exempt. Chrome has allowed it since Chrome 53, and Firefox allows it too.

Two caveats:

- **Safari is stricter** and has historically blocked it. Use Chrome or Firefox
  for the GM's browser if Bridge will not connect on a hosted Foundry.
- **Chrome 138 and later** are rolling out
  [Local Network Access](https://developer.chrome.com/blog/local-network-access)
  permission prompts. If Chrome asks whether the page may reach devices on your
  local network, that is this, and allowing it is what lets Vault answer.

If discovery finds nothing, `TV-DISCOVER-NONE` is the code, and
[the Vault address setting](Settings.md#the-vault-address) is where to point it
by hand.

## Changing address logs you out of your own credentials

The one genuinely module-specific thing on this page.

Browser storage is per **origin** — scheme, host and port together. Moving from
`http://localhost:30000` to `https://yourgame.example.com` is a different origin,
so:

- **Your Gemini key will not be there.** Lite quietly falls back to quoting
  passages and tells the GM once (`TV-LITE-NOKEY-HERE`). Set it again at the new
  address.
- **Your Vault pairing will not be there either**, or will be refused with
  `TV-BRIDGE-403`. Pair again from the address you now use.

Neither is a fault. It is the same browser rule that stops another website
reading your key, doing its job.

---

# Part two: Foundry's own security, which this module does not change

**Nothing in this section is caused by, worsened by, or specific to Tusk's
Vault.** It is how Foundry Virtual Tabletop behaves, and it applies identically
to every exposed Foundry server whether this module is installed or not. It is
here because it affects the *advice* above — not because it is ours.

Foundry's own documentation is the authority:
[hosting](https://foundryvtt.com/article/hosting/) ·
[SSL](https://foundryvtt.com/article/ssl/) ·
[port forwarding](https://foundryvtt.com/article/port-forwarding/).

## Three ways people run Foundry

| How you host | Transport | What you need to think about |
|---|---|---|
| **Managed host** (The Forge, Molten, similar) | **HTTPS**, done for you | Nothing. Your host terminates TLS and keeps a certificate valid. |
| **Self-hosted behind a tunnel or reverse proxy** (Cloudflare Tunnel, nginx, Caddy) | **HTTPS** | Put an access policy in front of it. A tunnel with no policy publishes your world to anyone who finds the hostname. |
| **Self-hosted with a forwarded port**, sharing your public IP | **HTTP by default** | This is the one worth reading on. See below. |

If you are in the first two rows, your transport is encrypted and authenticated
and there is nothing further to do.

## If you forward a port, Foundry serves plain HTTP unless you tell it otherwise

Foundry listens on port 30000 over **plain HTTP** out of the box. It can serve
HTTPS itself — `sslCert` and `sslKey` in `options.json`, per
[Foundry's SSL article](https://foundryvtt.com/article/ssl/) — but it does not
without a certificate.

Over plain HTTP, across the public internet, two things are true of **any**
Foundry server:

- **Traffic is not encrypted or authenticated**, so anyone positioned between a
  player and your server can read it and, more importantly, *modify pages as
  they are delivered*.
- **Foundry's join and admin passwords cross the wire in clear text**, so they
  can be captured.

Again: that is true of a bare Foundry install with no modules at all. Every GM
who forwards a port is in this position, and always has been.

**The fix is Foundry's, not this module's:** give Foundry a certificate, or put
it behind a tunnel or reverse proxy, or do not expose it to the internet at all
and use a VPN for your table. A Cloudflare Tunnel is the common
zero-configuration route and costs nothing.

## The one thing this module adds

Stated plainly, because it is the honest exception to "nothing changes".

If you switch on **lite written answers** and save a Gemini key, you have put a
spendable credential into your browser's storage. That does not change **who can
attack you or how** — the threat model above is identical, and every module you
have installed could already read that storage. It changes only **what a
successful attack is worth**.

The mitigations are the ordinary ones and they do not change with hosting, so
they live in one place: **[SECURITY.md](../SECURITY.md#if-you-use-lite-answers)**.

If you never turn on written answers — the default — the module stores no
credential at all and makes no network request.

## Never put private files in the module folder

Also Foundry's behaviour rather than this module's, and worth knowing because it
explains a design choice.

Foundry serves its data directory as unauthenticated static content, which on an
exposed Foundry means the open internet. That is why Lite reads journal entries
rather than files on disk.

What it means for where you keep a key, a `.env` or private notes:
[SECURITY.md](../SECURITY.md#never-put-private-files-in-the-modules-folder).

---

## Can I run Tusk's Vault on the server instead?

You can, if it is a server you control and can install software on, but you
almost certainly should not want to. Vault's whole design keeps your notes and
your API key on a machine you own. Putting it on rented infrastructure moves both
somewhere else to save you nothing — the browser route above already works, and
it keeps your key off every machine but yours.

If your host does not let you run software at all, which is the usual case for
managed Foundry hosting, the browser route is the only one anyway, and it is
fine.

---

## Where to go next

- **[Settings](Settings.md)** — the Vault address, and who may ask.
- **[Troubleshooting](Troubleshooting.md)** — every failure code and its fix.
- **[SECURITY.md](../SECURITY.md)** — where credentials live and what could go
  wrong.
