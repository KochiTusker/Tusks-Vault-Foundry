/**
 * Tusk's Vault — Foundry VTT module.
 *
 * Deliberately dumb. Nothing in this file can be covered by Vault's test suite
 * (Foundry cannot run in CI), so every decision that could live on the Vault
 * side does. What is left here is genuinely Foundry-shaped: knowing what a chat
 * command looks like, which client is allowed to dial out, and how to put a
 * message in the log.
 *
 * The one architectural fact worth knowing before reading:
 *
 *   `chatMessage` fires ONLY on the client that typed. `createChatMessage`
 *   fires on EVERY connected client.
 *
 * A player's browser cannot be assumed to reach Vault — Vault listens on the
 * GM's loopback and the player is on another machine. So the asker's client
 * swallows the command and posts a marked question document, and the ACTIVE
 * GM's client is the one that sees that document, relays it to Vault, and posts
 * the answer. `game.users.activeGM` returns exactly one active GM, which is the
 * election mechanism: without it, two connected GMs would each relay and the
 * table would get the answer twice, billed twice.
 */

const MODULE_ID = "tusks-vault";

/** The MCP protocol revision this module speaks. Checked against what Vault
 *  advertises before pairing — a clear "update Tusk's Vault" beats a confusing
 *  partial failure later. */
const PROTOCOL_VERSION = "2025-06-18";

/**
 * The Gemini model lite asks by default.
 *
 * Declared HERE, above every use, because it was previously written out three
 * times — in the defaults table, in the registration and beside the request —
 * and a retired model then had to be corrected in three places or the one that
 * was missed kept answering 404.
 *
 * Google retires models on its own schedule, so this WILL go stale again. When
 * it does, the provider's own error names the replacement ("This model … is no
 * longer available. Please update your code to use …"), the module prints that
 * sentence verbatim to the GM, and `TusksVault.models()` lists what the key can
 * actually reach. The setting is editable, so a GM is never blocked waiting for
 * a module release.
 */
/** Where everything user-facing lives. The same URL the manifest carries as
 *  `url`, asserted equal by the suite — a card pointing somewhere the package
 *  browser does not is two answers to one question. */
const DOCS_SITE = "https://kochitusker.github.io/Tusks-Vault/";

/** The source. Distinct from DOCS_SITE on purpose: one is where you learn what
 *  Vault is, the other is where you read what it does and download it. People
 *  arriving from a module in a game want different ones. */
const VAULT_REPO = "https://github.com/KochiTusker/Tusks-Vault";

/**
 * THIS repository — which is where Lite's documentation lives, and deliberately
 * not the documentation site.
 *
 * `docs/DocsLinks.md` sets the division and it is worth restating here, beside
 * the constant that depends on it: everything about Vault belongs on the site,
 * everything about the Foundry surface — settings, Lite, diagnostics — belongs
 * in `docs/` next to the code it describes. The site's own Foundry page says so
 * too, in as many words, and sends a reader here for Lite.
 *
 * So a help link about Lite points here. Pointing it at the site would be a
 * second front door onto documentation the site does not have.
 */
const MODULE_REPO = "https://github.com/KochiTusker/Tusks-Vault-Foundry";

/** The sibling project: session recordings into written chronicles, which then
 *  become lore Vault can answer from. Worth naming on the comparison because it
 *  is a reason to move up that has nothing to do with this module. */
const TOMES_SITE = "https://kochitusker.github.io/Tusks-Tomes/";

/**
 * Where somebody who has gone looking can say thank you.
 *
 * Reachable from exactly one place — the About screen — and from nowhere else.
 * Not the answer card, not a notification, not a first-run prompt. A donation
 * link in front of somebody who has not decided they like the thing yet reads
 * as the price of admission for something the licence says is free, and costs
 * more goodwill than it collects. Somebody who opened "About" is already
 * looking; they are the only audience this has.
 */
const SUPPORT_URL = "https://buymeacoffee.com/kochitusker";

const LITE_MODEL_DEFAULT = "gemini-3.8-flash";

/** Vault walks forward from its preferred port up to 20 times when the port is
 *  taken, so discovery probes exactly that range. A browser cannot read Vault's
 *  runtime port file and has no mDNS; this is the price of zero configuration. */
const DISCOVERY_BASE_PORT = 3000;
const DISCOVERY_PORT_COUNT = 20;
/** Written once so the failure notification and the diagnostic record cannot
 *  disagree about which ports were actually tried. */
const DISCOVERY_RANGE_LABEL = `${DISCOVERY_BASE_PORT}-${DISCOVERY_BASE_PORT + DISCOVERY_PORT_COUNT - 1}`;
const PROBE_TIMEOUT_MS = 1500;

/** An answer can take 5-10 seconds on a local subscription provider, and longer
 *  behind a queue. Generous, but bounded — a hung request must eventually tell
 *  the table something. */
const ASK_TIMEOUT_MS = 180_000;

const log = (...args) => console.log(`${MODULE_ID} |`, ...args);
const warn = (...args) => console.warn(`${MODULE_ID} |`, ...args);

/**
 * A ring buffer of what this module has done, and stable codes for what went
 * wrong.
 *
 * Foundry cannot be reached from a test suite, so when this module misbehaves
 * the only evidence is whatever the GM can be talked through capturing. A
 * console message is gone the moment the tab reloads and absent entirely if
 * F12 was not already open, and a chat message says what failed but never
 * where in the sequence. This keeps the sequence.
 *
 * PRIVACY, and this is not negotiable: a diagnostics dump is written to be
 * pasted into a public issue tracker. It therefore records STAGES and SHAPES —
 * a question's length, never its text; a token's length, never its value; no
 * answer text, no world title, no player names. Anything added here must pass
 * the same test.
 *
 * Capped, because a tab left open for a session of play would otherwise grow
 * this without bound.
 */
const EVENT_LIMIT = 100;
const events = [];

/** The loopback literals a browser will treat as this machine. `localhost` is
 *  included because a GM who types the address by hand usually types that.
 *
 *  Declared here rather than beside `describeBridgeUrl`, its other caller,
 *  because the scrub below needs it and the scrub must exist before anything
 *  can record an event. */
const LOOPBACK_HOST = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

/**
 * What gets stripped out of a recorded message, and why it is stripped HERE.
 *
 * The dump is written to be pasted into a public issue, and the issue template
 * and the privacy page both promise it records "shapes, never values". The
 * message field broke that promise: most of the strings recorded are error
 * prose from somebody else's software — Vault, Google, Foundry — and none of
 * those authors know they are writing into a public bug report. A filesystem
 * error names a home folder, which usually names a person; a Gemini quota
 * error carries the caller's cloud project number.
 *
 * Scrubbing on the way IN rather than on the way out is deliberate: a value
 * that was never recorded cannot be leaked by some later code path that reads
 * the buffer and forgets to filter it.
 */
const SCRUB_PATTERNS = [
  // C:\Users\<name>\… and \\server\share\… — the Windows home folder is the
  // single most reliable way to turn a bug report into a real first name.
  [/[A-Za-z]:\\[^\s"'`)\]]+/g, "<path>"],
  [/\\\\[^\s"'`)\]]+/g, "<path>"],
  // /home/<name>/… and /Users/<name>/… — the same on the other platforms.
  [/\/(?:home|Users)\/[^\s"'`)\]:]+/g, "<path>"],
  // Google's RESOURCE_EXHAUSTED prose carries the caller's project number.
  [/project[_-]?number:\s*\d+/gi, "project_number:<redacted>"],
  [/\bprojects\/[A-Za-z0-9-]{4,}/g, "projects/<redacted>"],
  // A hand-set Vault address is a hostname the GM chose, and hostnames are
  // routinely a person's name or their machine's ("vault.<firstname>-desktop.lan").
  // `describeBridgeUrl` already classifies the CONFIGURED value for exactly
  // this reason — but discovery, pairing and every bridge failure each name an
  // address in their own prose, so the config block was redacting a value the
  // event log below it then printed in full.
  //
  // Loopback survives with its port. The port is the whole question when
  // discovery fails, and the number identifies nobody.
  [
    /\bhttps?:\/\/[^\s"'`)\]]+/g,
    match => (LOOPBACK_HOST.test(match.replace(/\/+$/, "")) ? match : "<address>"),
  ],
];

/** Third-party prose is unbounded as well as unfiltered, so this caps it too:
 *  a stack trace pasted into a chat log helps nobody read the event before it. */
const MESSAGE_LIMIT = 300;

function scrubForDump(text) {
  let out = String(text ?? "");
  for (const [pattern, replacement] of SCRUB_PATTERNS) out = out.replace(pattern, replacement);
  return out.length > MESSAGE_LIMIT ? `${out.slice(0, MESSAGE_LIMIT)}…` : out;
}

/** `extra` is printed into the dump verbatim by `diagnostics()`, so it needs
 *  the same treatment as the message. Every value there today is a count or a
 *  fixed label — except the configured address discovery reports when it finds
 *  nothing, which is the one field that names a machine. */
function scrubExtra(extra) {
  const out = {};
  for (const [key, value] of Object.entries(extra)) {
    out[key] = typeof value === "string" ? scrubForDump(value) : value;
  }
  return out;
}

function record(level, code, message, extra) {
  const event = {
    at: new Date().toISOString(),
    level,
    code,
    message: scrubForDump(message),
  };
  if (extra) event.extra = scrubExtra(extra);
  events.push(event);
  if (events.length > EVENT_LIMIT) events.shift();
  return event;
}

/**
 * The next step, for the failures that have one.
 *
 * Returns "" for everything else on purpose: a hint that fires on failures it
 * cannot actually fix trains the reader to skip the line, and then it is not
 * there when it matters.
 *
 * 403 is the case worth catching. A bridge credential is bound to the exact
 * `scheme://host:port` it was paired from, which is a deliberate security
 * property — but it means the ordinary act of opening the same Foundry world on
 * a different address breaks the bridge. `localhost` → the machine's LAN IP
 * when the GM starts hosting for the table, `http` → `https` behind a proxy,
 * even `localhost` → `127.0.0.1`. Each produces a correct refusal that reads
 * like the module is broken, and each is fixed by pairing again.
 */
function recoveryHint(err) {
  const code = err?.code ?? "";
  if (code === "TV-BRIDGE-403" || code === "TV-BRIDGE-401") return t("chat.hintRepair");
  if (code === "TV-BRIDGE-UNREACHABLE") return t("chat.hintUnreachable");
  return "";
}

/** A stable code per transport outcome, so a GM can report "TV-BRIDGE-403" and
 *  it means one specific thing rather than "it did not work". */
function bridgeCode(status) {
  if (status === 0) return "TV-BRIDGE-UNREACHABLE";
  if (status === 401) return "TV-BRIDGE-401";
  if (status === 403) return "TV-BRIDGE-403";
  if (status === 404) return "TV-BRIDGE-404";
  if (status === 429) return "TV-BRIDGE-429";
  return `TV-BRIDGE-${status || "ERR"}`;
}

const t = (key, data) => game.i18n.format(`TUSKS_VAULT.${key}`, data ?? {});

/**
 * The values `setting()` falls back to when a read fails.
 *
 * Kept beside the registrations below and deliberately identical to them.
 */
const SETTING_DEFAULTS = {
  bridgeUrl: "",
  bridgeToken: "",
  answerSource: "bridge",
  liteFolder: "Tusk's Lore",
  liteAnswers: false,
  liteModel: LITE_MODEL_DEFAULT,
  liteFilters: false,
  liteScope: "all",
  geminiKey: "",
  enabled: true,
  accessMode: "whisper", // legacy; read once at migration and then ignored
  askPolicy: "everyone",
  allowedUsers: [],
  replyVisibility: "asker",
  policyMigrated: false,
  triggerCommand: "tusk",
  botName: "Tusk",
};

/**
 * Foundry's role ladder, as numbers.
 *
 * These are schema values on the User document rather than an implementation
 * detail, so hardcoding them is safe — but `CONST` is preferred when it exists,
 * because a value read from the running Foundry cannot drift from it.
 *
 * The one that surprises people: `User#isGM` is TRUE for an Assistant GM, not
 * only a full Gamemaster. Every "GM only" control in this module inherited that
 * meaning silently. The two tiers are now separate choices, and the setting
 * labels say which is which.
 */
const ROLES = {
  NONE: 0,
  PLAYER: 1,
  TRUSTED: 2,
  ASSISTANT: 3,
  GAMEMASTER: 4,
};

/** The floor each ask policy sets on the asker's role. `nobody` is a real
 *  choice, not a disabled state: paired with the allow list it expresses
 *  "these named people and no one else", which is the commonest request after
 *  the three defaults. */
const ASK_POLICY_FLOOR = {
  nobody: Infinity,
  gamemaster: ROLES.GAMEMASTER,
  gm: ROLES.ASSISTANT,
  trusted: ROLES.TRUSTED,
  everyone: ROLES.PLAYER,
};

let warnedAboutSettings = false;

/**
 * Whether the missing-key warning has been said for the CURRENT state.
 *
 * Once per question would be noise nobody reads. Once per session would be too
 * few: a GM who sets a key mid-session, then later clears it or moves to a
 * machine without one, is back in the same trap and deserves telling again. So
 * it re-arms whenever a key is seen.
 */
let warnedLiteKeyMissing = false;

/** Whether the welcome screen is on screen right now. Read only by the boot
 *  path, to keep it from telling a GM to go and pair while the dialog offering
 *  to do exactly that is still open in front of them. */
let firstRunOpen = false;

/**
 * Read a module setting, falling back to its default if it is not registered.
 *
 * `game.settings.get` THROWS for an unregistered key. Without this guard, a
 * failure during `init` — anything at all that stops `registerSettings()`
 * completing — turns every later `setting()` call into an exception, and an
 * exception inside a hook is swallowed by `Hooks.call`, which then treats the
 * hook as if it had declined. The visible result is `/tusk` reported as an
 * unknown command, with nothing anywhere saying why.
 *
 * Falling back keeps the chat trigger working on defaults in that state, and
 * says so once rather than silently.
 */
function setting(key) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch (err) {
    if (!warnedAboutSettings) {
      warnedAboutSettings = true;
      warn(`settings are not registered (${err?.message ?? err}); using defaults.`);
      record("error", "TV-INIT-UNREGISTERED", `settings not registered: ${err?.message ?? err}`);
    }
    return SETTING_DEFAULTS[key];
  }
}

/**
 * Keep an OPEN settings form in step with a setting written from elsewhere.
 *
 * Foundry's settings form is a SNAPSHOT. It reads every value once, at render,
 * and on save writes back every field it is holding —
 * `SettingsConfig.#onSubmit` iterates the whole of `formData.object` and calls
 * `game.settings.set` for each. So a setting changed while that form is open is
 * not merely displayed stale: pressing **Save Module Settings** writes the old
 * value back over the new one, silently.
 *
 * Which is exactly what the model picker did. A GM opened it from the settings
 * panel, chose a model, the setting was written, the text box above still read
 * the old name, and saving the panel they had opened the picker from undid the
 * choice they had just made in it.
 *
 * The same trap catches `recoverModel`, which moves the module off a model
 * Google has retired. That one matters more: it fires mid-session to repair a
 * broken table, and a settings panel left open would have reverted the repair.
 *
 * Done in `setSetting` rather than at the two call sites so it cannot be
 * forgotten by the next thing that writes a setting from a dialog.
 */
function syncOpenSettingsForm(key, value) {
  try {
    const fields = globalThis.document?.querySelectorAll?.(`[name="${MODULE_ID}.${key}"]`);
    for (const field of fields ?? []) {
      if (field.type === "checkbox") field.checked = !!value;
      else field.value = String(value ?? "");
      // Announced, not just assigned — the live mode switch listens for this,
      // so writing `answerSource` reveals the right half of the panel exactly
      // as moving the dropdown by hand does.
      try {
        field.dispatchEvent?.(new Event("change", { bubbles: true }));
      } catch {
        // No Event constructor (a non-browser host). The value is still correct.
      }
    }
  } catch {
    // No form open, or no DOM at all. Writing the setting is the part that
    // matters; keeping a form in step is a courtesy and must never throw.
  }
}

function setSetting(key, value) {
  return Promise.resolve(game.settings.set(MODULE_ID, key, value)).then(written => {
    syncOpenSettingsForm(key, value);
    return written;
  });
}

// ─── Settings ────────────────────────────────────────────────────────────────

/**
 * Scope matters more than usual here.
 *
 * `world` settings live on the Foundry server and only a GM can change them —
 * a real permission boundary. But they are ALSO distributed to every connected
 * client, which is how they take effect for players at all. So any player can
 * read a world setting out of `game.settings.get`.
 *
 * That makes the bridge token `client` scope, non-negotiably. A token in world
 * scope is a token every player at the table can read, and with it they could
 * talk to Vault directly and ask it anything, bypassing the table's access mode
 * entirely. Client scope is also correct on its own terms: the token is only
 * useful on the machine that can reach Vault's loopback, which is the GM's.
 */
function registerSettings() {
  /**
   * EVERY setting keeps an open panel in step — on every client, not just this one.
   *
   * `setSetting` already does this for the client that made the change, which
   * was the 1.1.0 model-picker fix and is only half of it: `liteModel` is
   * world-scoped, so a SECOND GM can have the settings panel open on another
   * machine. When `recoverModel` moves the table off a model Google has
   * retired, that GM's panel still holds the old name — and Foundry's submit
   * handler writes back every field it is holding, so pressing **Save Module
   * Settings** undoes the repair mid-session, on the table that was already
   * broken. That is precisely the failure the fix was written for, one client
   * over.
   *
   * Foundry fires `onChange` on every client that receives a world-setting
   * update, which is the half `setSetting` structurally cannot reach. Wrapping
   * the registration rather than editing nineteen of them means the next
   * setting added gets this for free, and cannot be the one that forgets.
   *
   * Running twice on the originating client is harmless: writing the same
   * value into the same field is idempotent.
   */
  const register = (key, definition) => game.settings.register(MODULE_ID, key, {
    ...definition,
    onChange: (value) => {
      syncOpenSettingsForm(key, value);
      definition.onChange?.(value);
    },
  });

  /**
   * Which half answers.
   *
   * The bridge is the default because that is what this module IS — the
   * Foundry end of Tusk's Vault. Lite is the front door for someone who has
   * not installed it yet, and saying so in the choice labels is the whole
   * upsell: there is no paywall here, only a download.
   */
  register("answerSource", {
    name: t("settings.answerSource.name"),
    hint: t("settings.answerSource.hint"),
    scope: "world",
    config: true,
    type: String,
    default: "bridge",
    choices: {
      bridge: t("settings.answerSource.bridge"),
      lite: t("settings.answerSource.lite"),
    },
  });

  register("bridgeUrl", {
    name: t("settings.bridgeUrl.name"),
    hint: t("settings.bridgeUrl.hint"),
    scope: "client",
    config: true,
    type: String,
    default: "",
  });

  register("bridgeToken", {
    scope: "client",
    config: false, // A secret has no business in a settings form.
    type: String,
    default: "",
  });

  register("liteFolder", {
    name: t("settings.liteFolder.name"),
    hint: t("settings.liteFolder.hint"),
    scope: "world",
    config: true,
    type: String,
    default: "Tusk's Lore",
  });

  /**
   * Layer 2. Off by default, and separate from the key on purpose: this is the
   * table's decision to spend on questions, and the key is a credential that
   * belongs to one machine. Conflating them would mean a GM could turn on
   * spending from a browser that cannot pay for it, or publish the fact that a
   * key exists to everyone at the table.
   */
  register("liteAnswers", {
    name: t("settings.liteAnswers.name"),
    hint: t("settings.liteAnswers.hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  /**
   * Off by default, matching Vault. A campaign archive is asked about war and
   * murder because the documents are about war and murder, and a filtered
   * refusal reads to a GM as the archive not knowing — the one thing the
   * citation rules exist to rule out.
   */
  register("liteFilters", {
    name: t("settings.liteFilters.name"),
    hint: t("settings.liteFilters.hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  register("liteModel", {
    name: t("settings.liteModel.name"),
    hint: t("settings.liteModel.hint"),
    scope: "world",
    config: true,
    type: String,
    default: LITE_MODEL_DEFAULT,
  });

  /**
   * What each answer may be assembled from.
   *
   * A THREE-WAY CHOICE rather than a switch, because "off" here has no obvious
   * meaning — off to everything in the folder, or off to what the table shares?
   * Those are opposite answers to the spoiler question, and a boolean would
   * pick one silently.
   *
   * `all` IS THE DEFAULT, AND THE REASON IS A FOUNDRY DEFAULT RATHER THAN A
   * PREFERENCE. `DocumentOwnershipField` initialises to `{default: NONE}`, so a
   * journal entry a GM creates is invisible to players until somebody opens the
   * ownership dialog and changes it — per entry. Scoping by ownership out of the
   * box therefore does not produce careful per-player answers; it produces "I
   * could not find anything" for every player question in every world where the
   * GM has not done that work, which is most of them. The folder is the boundary
   * a GM actually maintains: what you put in it is what the archivist may say.
   *
   * `asker` is the interesting mode and is offered as OPT-IN and EXPERIMENTAL.
   * When a GM does maintain per-user ownership — the Ownership Configuration
   * dialog, a level per player — this reads it, and two people asking the same
   * question are answered from different notes. It is the one thing this half
   * does that the full application structurally cannot, and it is also the one
   * that silently answers nothing if the permissions underneath it are not set
   * up. Hence opt-in.
   */
  register("liteScope", {
    name: t("settings.liteScope.name"),
    hint: t("settings.liteScope.hint"),
    scope: "world",
    config: true,
    type: String,
    default: "all",
    choices: {
      all: t("settings.liteScope.all"),
      shared: t("settings.liteScope.shared"),
      asker: t("settings.liteScope.asker"),
    },
    onChange: () => void warnIfScopeIsWideOpen(),
  });

  /**
   * The Gemini key. CLIENT scope and never in the settings form — the same two
   * rules the bridge token follows, for the same reason: a world setting is
   * distributed to every connected client, so a key stored there is a key
   * every player at the table can read out of `game.settings` and spend.
   *
   * Entered through the menu below, which states what it can and cannot
   * protect before it takes anything.
   */
  register("geminiKey", {
    scope: "client",
    config: false,
    type: String,
    default: "",
  });

  register("enabled", {
    name: t("settings.enabled.name"),
    hint: t("settings.enabled.hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  /**
   * The legacy tri-state, kept registered and hidden.
   *
   * It is no longer read by anything except `migratePolicy()`, which runs once
   * and translates it into the two settings below. Deregistering it would make
   * `game.settings.get` throw for a value that is still sitting in every
   * existing world's database, and there is no migration hook that fires before
   * the first read.
   */
  register("accessMode", {
    scope: "world",
    config: false,
    type: String,
    default: "whisper",
  });

  register("policyMigrated", {
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
  });

  /** Whether the first-run choice has been made or declined. Written either
   *  way, so declining is a decision the module remembers rather than a
   *  question it asks again every time the GM logs in. */
  register("setupDone", {
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
  });

  /**
   * Journal folders to read besides the named lore folder.
   *
   * Folder ids rather than names, because a folder can be renamed and two
   * folders can share a name — and because the GM picks these from a list, so
   * nobody ever has to see or type an id.
   */
  register("liteExtraFolders", {
    scope: "world",
    config: false,
    type: Array,
    default: [],
  });

  /**
   * Who may ask, as a floor on the asker's Foundry role.
   *
   * A role tier rather than a list, because a role is what a GM already
   * maintains: promoting a player to Trusted is a thing they do for other
   * reasons, and the archivist following that is less to keep in step than a
   * second list of names. The allow list below covers the cases a tier cannot
   * express.
   */
  register("askPolicy", {
    name: t("settings.askPolicy.name"),
    hint: t("settings.askPolicy.hint"),
    scope: "world",
    config: true,
    type: String,
    default: "everyone",
    choices: {
      nobody: t("settings.askPolicy.nobody"),
      gamemaster: t("settings.askPolicy.gamemaster"),
      gm: t("settings.askPolicy.gm"),
      trusted: t("settings.askPolicy.trusted"),
      everyone: t("settings.askPolicy.everyone"),
    },
  });

  /**
   * Named exceptions, added to whatever the tier allows.
   *
   * ADDITIVE on purpose. A deny list would need a rule for what happens when
   * the two disagree, and every such rule is a thing a GM has to hold in their
   * head to predict what their own table can do. "The tier, plus these people"
   * needs no rule. Set the tier to `nobody` and this list becomes the whole
   * policy, which is the "only these three players" case.
   *
   * Edited through the menu below rather than typed: a user id is a random
   * string nobody can recognise, so a text field here would be unusable.
   */
  register("allowedUsers", {
    scope: "world",
    config: false,
    type: Array,
    default: [],
  });

  /**
   * Who sees the answer — deliberately independent of who may ask.
   *
   * The old tri-state welded the two together and produced one combination
   * nobody wanted (GM-only questions answered publicly) while omitting the one
   * tables kept asking for: players may ask, but the GM reads the answer first
   * and decides what to say. That is `gm` here.
   */
  register("replyVisibility", {
    name: t("settings.replyVisibility.name"),
    hint: t("settings.replyVisibility.hint"),
    scope: "world",
    config: true,
    type: String,
    default: "asker",
    choices: {
      asker: t("settings.replyVisibility.asker"),
      gm: t("settings.replyVisibility.gm"),
      public: t("settings.replyVisibility.public"),
    },
  });

  register("triggerCommand", {
    name: t("settings.triggerCommand.name"),
    hint: t("settings.triggerCommand.hint"),
    scope: "world",
    config: true,
    type: String,
    default: "tusk",
  });

  register("botName", {
    name: t("settings.botName.name"),
    hint: t("settings.botName.hint"),
    scope: "world",
    config: true,
    type: String,
    default: "Tusk",
  });

  game.settings.registerMenu(MODULE_ID, "liteKey", {
    name: t("settings.liteKey.name"),
    label: t("settings.liteKey.label"),
    hint: t("settings.liteKey.hint"),
    icon: "fas fa-key",
    type: menuShim(openLiteKeyDialog),
    restricted: true,
  });

  game.settings.registerMenu(MODULE_ID, "liteWhyUpgrade", {
    name: t("settings.liteWhyUpgrade.name"),
    label: t("settings.liteWhyUpgrade.label"),
    hint: t("settings.liteWhyUpgrade.hint"),
    icon: "fas fa-circle-up",
    type: menuShim(openWhyUpgrade),
    // Not restricted: a player who opens settings can read what the table is
    // running, and nothing here is privileged.
    restricted: false,
  });

  game.settings.registerMenu(MODULE_ID, "liteModelPicker", {
    name: t("settings.liteModelPicker.name"),
    label: t("settings.liteModelPicker.label"),
    hint: t("settings.liteModelPicker.hint"),
    icon: "fas fa-list",
    type: menuShim(openModelPicker),
    restricted: true,
  });

  game.settings.registerMenu(MODULE_ID, "allowedUsers", {
    name: t("settings.allowList.name"),
    label: t("settings.allowList.label"),
    hint: t("settings.allowList.hint"),
    icon: "fas fa-user-check",
    type: menuShim(openAllowList),
    restricted: true,
  });

  game.settings.registerMenu(MODULE_ID, "liteFolders", {
    name: t("settings.liteFolders.name"),
    label: t("settings.liteFolders.label"),
    hint: t("settings.liteFolders.hint"),
    icon: "fas fa-folder-tree",
    type: menuShim(openFolderPicker),
    restricted: true,
  });

  game.settings.registerMenu(MODULE_ID, "lorePermissions", {
    name: t("settings.lorePermissions.name"),
    label: t("settings.lorePermissions.label"),
    hint: t("settings.lorePermissions.hint"),
    icon: "fas fa-user-lock",
    type: menuShim(openLorePermissions),
    restricted: true,
  });

  game.settings.registerMenu(MODULE_ID, "connect", {
    name: t("settings.connect.name"),
    label: t("settings.connect.label"),
    hint: t("settings.connect.hint"),
    icon: "fas fa-link",
    type: menuShim(runPairing),
    restricted: true,
  });

  game.settings.registerMenu(MODULE_ID, "faq", {
    name: t("settings.faq.name"),
    label: t("settings.faq.label"),
    hint: t("settings.faq.hint"),
    icon: "fas fa-circle-question",
    // Unrestricted. The person hitting the problem is often a player, and a
    // help screen only a GM can open is a help screen the table cannot use.
    restricted: false,
    type: menuShim(openFaq),
  });

  game.settings.registerMenu(MODULE_ID, "about", {
    name: t("settings.about.name"),
    label: t("settings.about.label"),
    hint: t("settings.about.hint"),
    icon: "fas fa-circle-info",
    // Not restricted, for the same reason the upgrade screen is not: a player
    // who can open settings can already read what the table is running, and the
    // diagnostics button is the fastest route to a useful bug report from
    // whoever happens to be the one seeing the problem.
    restricted: false,
    type: menuShim(openAbout),
  });

}

/**
 * Show a GM the settings for the half they are actually running.
 *
 * Somebody on lite has no Vault to pair with, and somebody on the bridge has
 * no use for a Gemini key. Showing both sets to everyone means every GM reads
 * a panel that is half irrelevant and has to work out which half — which is
 * how a setting gets changed by mistake.
 *
 * Registration is never undone: `game.settings.get` THROWS for an unregistered
 * key, so a hidden setting is still registered and still readable. Only
 * `config` — whether the form draws it — moves.
 */
/**
 * How the module's settings are laid out, and which half each part belongs to.
 *
 * ONE list drives three things — the order rows appear in, the headings that
 * separate them, and which rows exist at all in a given mode. Three separate
 * lists would be three chances to add a setting to one and forget the others,
 * and the failure is silent: a setting rendered in the wrong section, or in a
 * mode where it means nothing.
 *
 * A section with no `mode` belongs to both halves.
 */
const SETTINGS_LAYOUT = [
  { heading: "sections.mode", keys: ["answerSource"] },
  { heading: "sections.bridge", mode: "bridge", keys: ["menu:connect", "bridgeUrl"] },
  {
    heading: "sections.lite",
    mode: "lite",
    keys: [
      "menu:liteKey",
      "liteFolder",
      "menu:liteFolders",
      "liteScope",
      "menu:lorePermissions",
      "liteAnswers",
      "liteFilters",
      "liteModel",
      "menu:liteModelPicker",
      "menu:liteWhyUpgrade",
    ],
  },
  {
    heading: "sections.table",
    keys: ["enabled", "askPolicy", "menu:allowedUsers", "replyVisibility", "triggerCommand", "botName"],
  },
  // Last, and in both halves. Somebody who has scrolled this far is either
  // finished configuring or looking for help, and both are what is here.
  { heading: "sections.help", keys: ["menu:faq", "menu:about"] },
];

/**
 * Show and hide the two halves LIVE, without saving first.
 *
 * The obvious mechanism — Foundry's `config` flag — was the wrong one, and the
 * symptom is instructive: the flag decides whether a row is RENDERED, so the
 * half that was not running did not exist in the form at all. Nothing could
 * reveal it, and switching the dropdown appeared to do nothing until the GM
 * saved and reopened the window. A setting that needs a save-and-reopen to show
 * its own effect reads as broken.
 *
 * So every row is rendered and the inactive half is hidden with a class, which
 * a `change` listener on the select can flip the instant it moves. The hidden
 * inputs still submit on Save, carrying the values they already had — a no-op
 * write, and the price of the rows existing to be shown.
 */
function applyModeClasses(byMode, lite) {
  const wanted = lite ? "lite" : "bridge";
  for (const [mode, elements] of Object.entries(byMode)) {
    for (const element of elements) element.classList?.toggle?.("tusks-vault-hidden", mode !== wanted);
  }
}

/** Which setting or menu a rendered row belongs to. Returns `menu:<key>` for a
 *  settings menu, the bare key for a setting, or null for somebody else's row. */
function settingRowKey(group) {
  const input = group.querySelector?.(`[name^="${MODULE_ID}."]`);
  if (input?.name) return input.name.slice(MODULE_ID.length + 1);
  const button = group.querySelector?.(`button[data-key^="${MODULE_ID}."]`);
  if (button?.dataset?.key) return `menu:${button.dataset.key.slice(MODULE_ID.length + 1)}`;
  return null;
}

/**
 * Lay the module's settings out in sections, under headings.
 *
 * Foundry renders one flat list per package — every menu first, then every
 * setting in registration order — and offers no grouping of its own. For a
 * module that is two things at once, that reads as a wall of controls in which
 * the one deciding what the others mean is somewhere in the middle. So the
 * rows are reordered here and headings are inserted between them.
 *
 * Menus are also why this cannot be done with the `config` flag alone: a
 * settings menu has no such flag, so the only place to drop the one that does
 * not apply is the rendered form.
 */
Hooks.on("renderSettingsConfig", (_app, html) => {
  const root = domRoot(html);
  if (!root?.querySelectorAll) return;

  // Our rows, wherever Foundry happened to put them.
  const rows = new Map();
  let section = null;
  for (const group of root.querySelectorAll(".form-group")) {
    const key = settingRowKey(group);
    if (!key) continue;
    rows.set(key, group);
    section = section ?? group.parentElement;
  }
  if (!section || rows.size === 0) return;

  const anchor = document.createComment(MODULE_ID);
  section.insertBefore(anchor, rows.values().next().value);
  const byMode = { bridge: [], lite: [] };

  for (const block of SETTINGS_LAYOUT) {
    const present = block.keys.map(key => rows.get(key)).filter(Boolean);
    for (const key of block.keys) rows.delete(key);
    if (present.length === 0) continue;

    const heading = document.createElement("h3");
    heading.className = "tusks-vault-section";
    heading.textContent = t(block.heading);
    section.insertBefore(heading, anchor);
    for (const row of present) section.insertBefore(row, anchor);

    // Everything in a mode-specific block is shown and hidden together, the
    // heading with its rows — a heading left behind over nothing is worse than
    // no heading at all.
    if (block.mode) byMode[block.mode].push(heading, ...present);
  }

  // Anything the layout does not name still belongs to this module and must
  // not vanish: a setting added without updating SETTINGS_LAYOUT lands here,
  // visible and unsectioned, rather than disappearing without a trace.
  for (const row of rows.values()) section.insertBefore(row, anchor);
  anchor.remove();

  const select = root.querySelector(`[name="${MODULE_ID}.answerSource"]`);
  applyModeClasses(byMode, (select?.value ?? setting("answerSource")) === "lite");
  // The live part. `change` fires as the GM moves the dropdown, long before
  // anything is written, which is the whole point.
  select?.addEventListener?.("change", event => {
    applyModeClasses(byMode, event.target.value === "lite");
  });
});

/**
 * A settings-menu entry needs an application-shaped class, but this "menu" is a
 * one-shot action rather than a form. Foundry does `new menu.type()` then
 * `await app.render(true)`, so overriding `render` to run the flow and never
 * open a window is the least-ceremony way to get a button.
 *
 * ApplicationV2 rather than FormApplication: `registerMenu` accepts either, but
 * FormApplication has been deprecated since v13 and is scheduled for removal in
 * v16 — extending it would give this module a known expiry date and a
 * compatibility warning in every GM's console. The fallback covers the
 * theoretical case of ApplicationV2 being absent; it exists from v13, which is
 * this module's declared minimum.
 *
 * Built lazily, when `init` fires, rather than at module scope. Reading a
 * Foundry global while this file is still being evaluated makes the ENTIRE
 * module fail to load if that global is not ready yet — and a module that fails
 * to load registers no hooks, which presents as "/tusk is not a valid chat
 * message command" with nothing in the settings panel to hint at the cause.
 * Nothing at module scope may touch a Foundry global for that reason.
 */
function menuShim(action) {
  const MenuBase = foundry?.applications?.api?.ApplicationV2 ?? globalThis.FormApplication;
  return class SettingsMenuShim extends MenuBase {
    render() {
      // Not `void`: a rejection here has nowhere else to surface. The menu is
      // the only way most GMs ever start pairing, and an unhandled rejection
      // would close the dialog with nothing said at all.
      Promise.resolve()
        .then(action)
        .catch(err => {
          console.error(`${MODULE_ID} | settings menu failed:`, err);
          ui.notifications?.error?.(`Tusk's Vault: ${err?.message ?? err}`);
        });
      return this;
    }
  };
}

// ─── Access policy ───────────────────────────────────────────────────────────

/** The allow list, always as a fresh array of ids. Foundry hands back whatever
 *  is in the database, which for a hand-edited world can be anything at all. */
function allowedUserIds() {
  const raw = setting("allowedUsers");
  return Array.isArray(raw) ? raw.filter(id => typeof id === "string") : [];
}

/**
 * May this user ask?
 *
 * Takes the user document rather than a bare `isGM`, because the whole point of
 * the tier is that it distinguishes ranks `isGM` collapses. Falls back to the
 * boolean when a role is missing, which keeps this working against anything
 * that hands us a partial user.
 */
function mayAsk(policy, allowed, user) {
  if (!user) return false;
  if (allowed.includes(user.id)) return true;
  const floor = ASK_POLICY_FLOOR[policy] ?? ASK_POLICY_FLOOR.everyone;
  const role = typeof user.role === "number"
    ? user.role
    : (user.isGM ? ROLES.ASSISTANT : ROLES.PLAYER);
  return role >= floor;
}

/**
 * Who sees the answer.
 *
 * An empty array is Foundry's "everyone", which makes an empty GM list the one
 * genuinely dangerous outcome here: it would publish to the table the answer a
 * GM asked to read privately. The relay has already established that it is
 * itself the active GM by this point, so the fallback cannot be reached — it is
 * here because the cost of being wrong is a spoiler and the cost of the guard is
 * one line.
 */
function whisperTargets(visibility, askerId) {
  if (visibility === "public") return [];
  const gmIds = game.users.filter(u => u.isGM && u.active).map(u => u.id);
  if (gmIds.length === 0) gmIds.push(game.user.id);
  if (visibility === "gm") return [...new Set(gmIds)];
  return [...new Set([askerId, ...gmIds])];
}

/**
 * Translate the older single tri-state into the two settings that replaced it.
 *
 * Deliberately not named after a version: the public series starts at 1.0.0,
 * so no released build ever had `accessMode`, and citing a number here would
 * send a reader looking for a release that does not exist. The setting is
 * still read, because worlds built on the pre-release builds hold it.
 *
 * Runs once, on the active GM's client only — a world setting can only be
 * written by a GM, and two GMs writing the same three keys at the same moment
 * is a race with no upside.
 *
 * The mapping preserves what each old mode DID, including the combination
 * nobody chose deliberately: `gm-only` posted its answers publicly, so that is
 * what it migrates to. Silently improving it here would change the behaviour of
 * a table that had not asked for a change.
 */
async function migratePolicy() {
  if (setting("policyMigrated")) return;

  // `whisper` is deliberately absent: it was the old default and it maps
  // exactly onto the new ones, so a world that sat on it has nothing to carry
  // over. Listing it would only mean writing values identical to the defaults —
  // and would overwrite a choice a GM had already made in the new settings.
  const legacy = setting("accessMode");
  const mapping = {
    "gm-only": { askPolicy: "gm", replyVisibility: "public" },
    public: { askPolicy: "everyone", replyVisibility: "public" },
  }[legacy];

  if (mapping) {
    await setSetting("askPolicy", mapping.askPolicy);
    await setSetting("replyVisibility", mapping.replyVisibility);
    record("info", "TV-POLICY-MIGRATED", `accessMode "${legacy}" became ${mapping.askPolicy}/${mapping.replyVisibility}`);
  }
  await setSetting("policyMigrated", true);
}

/**
 * The allow-list picker.
 *
 * A checkbox per user rather than a text field, because the stored value is a
 * Foundry user id — a random string that nobody can read, match to a person, or
 * type correctly. The list is the only place the ids and the names are both
 * available.
 *
 * Everyone in the world is listed, GMs included and shown as already covered by
 * most tiers. Ticking a GM is not useless: with the tier set to `nobody`, the
 * list is the entire policy, and a GM excluded from it cannot ask either.
 */
async function openAllowList() {
  if (!game.user.isGM) {
    ui.notifications.warn(t("notify.gmOnlyAllowList"));
    return;
  }

  const selected = new Set(allowedUserIds());
  // `filter` rather than spreading: `game.users` is a Collection, and this is
  // the accessor that yields a plain array of documents on every version.
  // Highest rank first, so the people a tier already covers sit together.
  const users = game.users
    .filter(() => true)
    .sort((a, b) => (b.role ?? 0) - (a.role ?? 0) || String(a.name).localeCompare(String(b.name)));

  const rows = users
    .map(user => {
      const checked = selected.has(user.id) ? " checked" : "";
      return `<label class="tusks-vault-allow-row">
        <input type="checkbox" name="tusks-vault-user" value="${escapeHtml(user.id)}"${checked}>
        <span class="tusks-vault-allow-name">${escapeHtml(user.name ?? user.id)}</span>
        <span class="tusks-vault-allow-role">${escapeHtml(roleLabel(user.role))}</span>
      </label>`;
    })
    .join("");

  const content = `<p>${t("dialog.allowList.body")}</p>
    <div class="tusks-vault-allow-list">${rows || `<p class="notes">${t("dialog.allowList.empty")}</p>`}</div>
    <p class="notes">${t("dialog.allowList.hint")}</p>`;

  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) {
    // v13 is the declared minimum and DialogV2 exists there, so this is the
    // "something replaced the API" case rather than an expected one. Saying so
    // beats rendering nothing.
    ui.notifications.error(t("notify.allowListUnavailable"));
    return;
  }

  const save = (_event, button, dialog) => {
    // The callback's third argument has been the dialog in some versions and
    // the rendered html in others, and `button.form` is populated in both.
    // Trying all three is three lines against a silent no-op on save.
    const root = dialog?.element ?? dialog ?? button?.form ?? null;
    const boxes = root?.querySelectorAll?.('input[name="tusks-vault-user"]') ?? [];
    const ids = [...boxes].filter(box => box.checked).map(box => box.value);
    setSetting("allowedUsers", ids)
      .then(() => {
        record("info", "TV-ALLOWLIST-SET", `allow list now holds ${ids.length} user(s)`);
        ui.notifications.info(t("notify.allowListSaved", { count: ids.length }));
      })
      .catch(err => {
        record("error", "TV-ALLOWLIST-FAIL", err?.message ?? String(err));
        ui.notifications.error(t("notify.allowListFailed", { detail: err?.message ?? String(err) }));
      });
  };

  const dialog = new DialogV2({
    window: { title: t("dialog.allowList.title") },
    content,
    buttons: [
      { action: "save", label: t("dialog.allowList.save"), default: true, callback: save },
      { action: "cancel", label: t("dialog.allowList.cancel") },
    ],
  });
  void Promise.resolve(dialog.render({ force: true })).catch(err => {
    // An ApplicationV2 render can reject, and an un-awaited rejection is an
    // unhandled one: the dialog silently never appears and nothing says why.
    warn("a dialog could not be rendered", err);
    ui.notifications?.error?.(t("notify.dialogFailed"));
  });
  return dialog;
}

/**
 * Take the Gemini key, and say what it can and cannot protect first.
 *
 * The disclosure is not a footnote in a readme. Foundry has no module
 * sandboxing: every other module the GM has installed runs on this origin and
 * can read this browser's storage. That is a real, specific consequence of
 * choosing layer 2, the GM is the only person who can weigh it, and the moment
 * they are deciding is the only moment they will read it. So it is here, above
 * the field, in the dialog that takes the key.
 *
 * The existing key is NEVER rendered back into the form — a secret in a form
 * is a secret in a screenshot. The dialog reports only that one is set, and
 * how long it is.
 */
async function openLiteKeyDialog() {
  if (!game.user.isGM) {
    ui.notifications.warn(t("notify.gmOnlyKey"));
    return;
  }

  const existing = (setting("geminiKey") || "").trim();
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) {
    ui.notifications.error(t("notify.allowListUnavailable"));
    return;
  }

  const content = `<div class="tusks-vault-keyform">
    <p>${t("dialog.liteKey.body")}</p>
    <div class="tusks-vault-risk">
      <p class="tusks-vault-risk-head">${t("dialog.liteKey.riskHead")}</p>
      <ul>
        <li>${t("dialog.liteKey.riskModules")}</li>
        <li>${t("dialog.liteKey.riskPlayers")}</li>
        <li>${t("dialog.liteKey.riskCap")}</li>
      </ul>
      <p class="notes">${t("dialog.liteKey.riskFull")}</p>
    </div>
    <p class="notes">${existing ? t("dialog.liteKey.present", { length: existing.length }) : t("dialog.liteKey.absent")}</p>
    <input type="password" name="tusks-vault-key" autocomplete="off" spellcheck="false"
      placeholder="${t("dialog.liteKey.placeholder")}">
    <p class="notes">${t("dialog.liteKey.where")}</p>
  </div>`;

  const write = async (value, savedKey, clearedKey) => {
    try {
      await setSetting("geminiKey", value);
      record("info", value ? "TV-LITE-KEY-SET" : "TV-LITE-KEY-CLEARED", `key length ${value.length}`);
      ui.notifications.info(t(value ? savedKey : clearedKey));
    } catch (err) {
      record("error", "TV-LITE-KEY-FAIL", err?.message ?? String(err));
      ui.notifications.error(t("notify.keyFailed", { detail: err?.message ?? String(err) }));
    }
  };

  const dialog = new DialogV2({
    window: { title: t("dialog.liteKey.title") },
    content,
    buttons: [
      {
        action: "save",
        label: t("dialog.liteKey.save"),
        default: true,
        callback: (_event, button, dlg) => {
          const root = dlg?.element ?? dlg ?? button?.form ?? null;
          const field = root?.querySelector?.('input[name="tusks-vault-key"]');
          const value = String(field?.value ?? "").trim();
          // An empty box on save is a no-op, not a delete: somebody who opened
          // the dialog to look and pressed Save should not silently lose the
          // key they already had. Clearing is its own button.
          if (!value) {
            ui.notifications.info(t("notify.keyUnchanged"));
            return;
          }
          void write(value, "notify.keySaved", "notify.keyCleared");
        },
      },
      {
        action: "clear",
        label: t("dialog.liteKey.clear"),
        callback: () => void write("", "notify.keySaved", "notify.keyCleared"),
      },
      { action: "cancel", label: t("dialog.liteKey.cancel") },
    ],
  });
  void Promise.resolve(dialog.render({ force: true })).catch(err => {
    // An ApplicationV2 render can reject, and an un-awaited rejection is an
    // unhandled one: the dialog silently never appears and nothing says why.
    warn("a dialog could not be rendered", err);
    ui.notifications?.error?.(t("notify.dialogFailed"));
  });
  return dialog;
}

/**
 * Choose a model from what the key can actually reach today.
 *
 * The list is fetched, not hardcoded, for the same reason the default is a
 * single constant: any set of names written now is wrong by some later date,
 * and a stale dropdown is worse than a text field because it looks
 * authoritative. Filtered to the policy — flash and flash-lite, version 3 and
 * above — and ranked best first.
 */
async function openModelPicker() {
  if (!game.user.isGM) {
    ui.notifications.warn(t("notify.gmOnlyKey"));
    return;
  }
  const key = (setting("geminiKey") || "").trim();
  if (!key) {
    ui.notifications.warn(t("lite.noKey"));
    return;
  }

  let all;
  try {
    all = await fetchGeminiModels(key);
  } catch (err) {
    ui.notifications.error(t("notify.modelListFailed", { detail: err?.message ?? String(err) }));
    return;
  }

  const allowed = rankModels(all);
  if (allowed.length === 0) {
    ui.notifications.warn(t("notify.noAllowedModels", { count: all.length }));
    return;
  }

  const current = (setting("liteModel") || "").trim();
  const options = allowed
    .map(m => {
      const selected = m.name === current ? " selected" : "";
      const kind = m.lite ? t("dialog.model.lite") : t("dialog.model.flash");
      return `<option value="${escapeHtml(m.name)}"${selected}>${escapeHtml(m.name)} — ${kind}</option>`;
    })
    .join("");

  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) {
    ui.notifications.error(t("notify.allowListUnavailable"));
    return;
  }

  const dialog = new DialogV2({
    window: { title: t("dialog.model.title") },
    content: `<div class="tusks-vault-keyform">
      <p>${t("dialog.model.body", { allowed: allowed.length, total: all.length })}</p>
      <select name="tusks-vault-model">${options}</select>
      <p class="notes">${t("dialog.model.note")}</p>
    </div>`,
    buttons: [
      {
        action: "save",
        label: t("dialog.model.save"),
        default: true,
        callback: (_event, button, dlg) => {
          const root = dlg?.element ?? dlg ?? button?.form ?? null;
          const value = root?.querySelector?.('select[name="tusks-vault-model"]')?.value;
          if (!value) return;
          setSetting("liteModel", value)
            .then(() => ui.notifications.info(t("notify.modelChosen", { model: value })))
            .catch(err => ui.notifications.error(t("notify.keyFailed", { detail: err?.message ?? String(err) })));
        },
      },
      { action: "cancel", label: t("dialog.model.cancel") },
    ],
  });
  void Promise.resolve(dialog.render({ force: true })).catch(err => {
    // An ApplicationV2 render can reject, and an un-awaited rejection is an
    // unhandled one: the dialog silently never appears and nothing says why.
    warn("a dialog could not be rendered", err);
    ui.notifications?.error?.(t("notify.dialogFailed"));
  });
  return dialog;
}

/**
 * What moving up to Tusk's Vault actually gets you.
 *
 * One screen rather than prose scattered through the panel, and reachable only
 * from the lite half — somebody already running the bridge has it and does not
 * need selling it again.
 *
 * The rows are the honest differences, including the two that are not
 * flattering to lite: its corpus is one folder, and its key sits in a browser.
 * A comparison that only lists wins is an advertisement; one that names the
 * trade is a reason to trust the rest of the module.
 */
// The "400+ models" claim in the providers row is OpenRouter's live catalogue,
// counted from https://openrouter.ai/api/v1/models — 431 across 58 authors when
// this was written. Stated as a floor rather than a figure because a catalogue
// grows: "400+" stays true as it does, where an exact number would not.
const UPGRADE_ROWS = [
  "lore",
  "size",
  "finding",
  "paying",
  "providers",
  "key",
  "voices",
  "gaps",
  "price",
];

async function openWhyUpgrade() {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) {
    ui.notifications.error(t("notify.allowListUnavailable"));
    return;
  }

  const rows = UPGRADE_ROWS.map(id => {
    const cells = [
      t(`dialog.why.rows.${id}.label`),
      t(`dialog.why.rows.${id}.lite`),
      t(`dialog.why.rows.${id}.vault`),
    ].map(escapeHtml);
    return `<tr><th scope="row">${cells[0]}</th><td>${cells[1]}</td><td>${cells[2]}</td></tr>`;
  }).join("");

  const dialog = new DialogV2({
    window: { title: t("dialog.why.title") },
    content: `<div class="tusks-vault-why">
      <p>${escapeHtml(t("dialog.why.body"))}</p>
      <table class="tusks-vault-why-table">
        <thead><tr><th></th><th>${escapeHtml(t("dialog.why.lite"))}</th><th>${escapeHtml(t("dialog.why.vault"))}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="tusks-vault-why-loop">
        <strong>${escapeHtml(t("dialog.why.loopHead"))}</strong>
        ${escapeHtml(t("dialog.why.loopBody"))}
      </p>
      <p class="tusks-vault-why-cta">
        <a href="${DOCS_SITE}">${escapeHtml(t("dialog.why.link"))}</a>
        <a href="${VAULT_REPO}">${escapeHtml(t("dialog.why.repo"))}</a>
        <a href="${TOMES_SITE}">${escapeHtml(t("dialog.why.tomes"))}</a>
      </p>
      <p class="notes">${escapeHtml(t("dialog.why.note"))}</p>
    </div>`,
    buttons: [{ action: "close", label: t("dialog.why.close"), default: true }],
  });
  void Promise.resolve(dialog.render({ force: true })).catch(err => {
    // An ApplicationV2 render can reject, and an un-awaited rejection is an
    // unhandled one: the dialog silently never appears and nothing says why.
    warn("a dialog could not be rendered", err);
    ui.notifications?.error?.(t("notify.dialogFailed"));
  });
  return dialog;
}

/**
 * Keep an existing world answering the way it did yesterday.
 *
 * `liteScope` is new, and its default — read the whole folder — is right for a
 * fresh install and WRONG to impose on a world that is already running. Before
 * this release lite always filtered by the asker's journal ownership. A GM who
 * had set those permissions and relied on them would have found, after an
 * update they did not ask for, that the archivist had started answering players
 * from lore it previously withheld. That is a spoiler regression delivered
 * silently, which is the worst way to deliver one.
 *
 * So an upgrading world is pinned to the behaviour it already had, and the
 * wider default applies only where there is no previous behaviour to preserve.
 * The GM is told once, because a setting that appeared and was decided for them
 * should not also be a secret.
 *
 * Runs once, in the same branch that marks setup done, so it cannot fight a
 * choice the GM makes afterwards.
 */
async function adoptPreviousScope() {
  try {
    await setSetting("liteScope", "asker");
    record("info", "TV-SCOPE-PRESERVED", "existing world pinned to per-asker scoping");
    // Only worth saying to somebody who might act on it. A bridge table has no
    // lite scope to care about.
    if (usingLite()) ui.notifications?.info?.(t("notify.scopePreserved"));
  } catch (err) {
    warn("could not preserve the previous lore scope", err);
  }
}

/**
 * The first thing a GM sees, and the reason it exists.
 *
 * The module ships defaulted to the bridge, because that is what it IS — the
 * Foundry end of Tusk's Vault. But the package listing promises that installing
 * it gives you something that "runs inside the module on its own", and those two
 * facts met at the worst possible moment: a one-click install, then `/tusk`,
 * then "Tusk's Vault is not paired with this world yet → Connect" — an
 * instruction to connect to an application the GM has not downloaded and was
 * told they would not need.
 *
 * Flipping the default would have fixed the newcomer and broken everyone else:
 * a GM already running the bridge never had to change the setting, so nothing
 * is stored, so an upgrade would silently move a working table onto lite. The
 * choice is asked instead — once, on the first run in a world, with the
 * consequences of each option stated rather than implied.
 *
 * Only ever shown in a world the module has never run in before; see the caller.
 */
async function runFirstRun() {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) return false;

  const folder = setting("liteFolder") || LITE_DEFAULT_FOLDER;
  const content = `<div class="tusks-vault-setup">
    <p>${escapeHtml(t("dialog.setup.body"))}</p>
    <div class="tusks-vault-setup-option">
      <h4>${escapeHtml(t("dialog.setup.liteHead"))}</h4>
      <p>${escapeHtml(t("dialog.setup.liteBody", { folder }))}</p>
    </div>
    <div class="tusks-vault-setup-option">
      <h4>${escapeHtml(t("dialog.setup.bridgeHead"))}</h4>
      <p>${escapeHtml(t("dialog.setup.bridgeBody"))}</p>
    </div>
    <p class="notes">${escapeHtml(t("dialog.setup.either"))}</p>
  </div>`;

  return new Promise(resolve => {
    const dialog = new DialogV2({
      window: { title: t("dialog.setup.title") },
      content,
      buttons: [
        { action: "lite", label: t("dialog.setup.chooseLite"), default: true, callback: () => "lite" },
        { action: "bridge", label: t("dialog.setup.chooseBridge"), callback: () => "bridge" },
        { action: "later", label: t("dialog.setup.later"), callback: () => "later" },
      ],
      submit: async choice => {
        await applySetupChoice(choice);
        resolve(choice);
      },
      // Dismissing the window is "later", not an unanswered question. A dialog
      // that comes back every login because it was closed with Escape is worse
      // than one that was never shown.
      close: () => resolve(null),
    });
    void Promise.resolve(dialog.render({ force: true })).catch(err => {
      // An ApplicationV2 render can reject, and an un-awaited rejection is
      // an unhandled one: the dialog never appears and nothing says why.
      warn("a dialog could not be rendered", err);
      ui.notifications?.error?.(t("notify.dialogFailed"));
    });
  }).then(async choice => {
    if (choice === null) await setSetting("setupDone", true).catch(() => {});
    return choice;
  });
}

/**
 * Do what the first-run choice said, and leave the GM able to type a question.
 *
 * Creating the folder is the part that matters. "Make a journal folder called
 * Tusk's Lore" is one step, but it is one step between installing something and
 * seeing it work, and it is the step at which the module looks broken — the
 * error for a missing folder is indistinguishable from the error for a module
 * that is not answering.
 */
async function applySetupChoice(choice) {
  await setSetting("setupDone", true);
  if (choice === "later") return;

  if (choice === "bridge") {
    await setSetting("answerSource", "bridge");
    record("info", "TV-SETUP-BRIDGE", "first run: chose the bridge");
    await runPairing();
    return;
  }

  await setSetting("answerSource", "lite");
  const name = setting("liteFolder") || LITE_DEFAULT_FOLDER;
  let made = false;
  if (!loreFolder()) {
    try {
      await Folder.create({ name, type: "JournalEntry" });
      made = true;
    } catch (err) {
      // Not fatal: lite works the moment the folder exists, whoever makes it.
      warn("could not create the lore folder", err);
      record("warn", "TV-SETUP-FOLDER-FAIL", err?.message ?? String(err));
    }
  }
  record("info", "TV-SETUP-LITE", "first run: chose lite", { folderCreated: made });
  ui.notifications?.info?.(t(made ? "notify.setupLiteMade" : "notify.setupLiteReady", {
    folder: name,
    command: setting("triggerCommand") || "tusk",
  }));
}

/**
 * About, help, and the one place the project asks for anything.
 *
 * Three jobs, and the middle one is why it is not just a credits box.
 * `TusksVault.diagnostics()` is the single most useful thing a GM can send with
 * a bug report, and until 1.1.0 the only way to run it was the F12 console —
 * which is a wall for precisely the non-technical GM this module is aimed at,
 * and a round trip on every report that does get filed. A button removes both.
 *
 * Unrestricted, like the upgrade screen: nothing here is privileged, and a
 * player who can open settings can already read what the table is running.
 */
async function openAbout() {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) {
    ui.notifications.error(t("notify.allowListUnavailable"));
    return;
  }

  const mod = game.modules?.get?.(MODULE_ID);
  const rows = [
    [t("dialog.about.module"), `v${mod?.version ?? "?"}`],
    [t("dialog.about.foundry"), String(game.version ?? "?")],
    [t("dialog.about.mode"), usingLite() ? t("dialog.about.modeLite") : t("dialog.about.modeBridge")],
  ]
    .map(([label, value]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join("");

  const link = (href, label) => `<a href="${href}">${escapeHtml(label)}</a>`;

  const content = `<div class="tusks-vault-about">
    <p>${escapeHtml(t("dialog.about.blurb"))}</p>
    <table class="tusks-vault-about-table"><tbody>${rows}</tbody></table>

    <h4>${escapeHtml(t("dialog.about.helpHead"))}</h4>
    <p class="notes">${escapeHtml(t("dialog.about.helpBody"))}</p>
    <p><button type="button" class="tusks-vault-copy-diagnostics">
      <i class="fas fa-clipboard"></i> ${escapeHtml(t("dialog.about.copy"))}
    </button></p>

    <h4>${escapeHtml(t("dialog.about.linksHead"))}</h4>
    <p class="tusks-vault-about-links">
      ${link(DOCS_SITE, t("dialog.about.guide"))} ·
      ${link(`${VAULT_REPO}-Foundry/issues`, t("dialog.about.issues"))} ·
      ${link(`${VAULT_REPO}-Foundry`, t("dialog.about.source"))} ·
      ${link(`${VAULT_REPO}-Foundry/blob/main/LICENSE`, t("dialog.about.licence"))}
    </p>

    <h4>${escapeHtml(t("dialog.about.supportHead"))}</h4>
    <p class="notes">${escapeHtml(t("dialog.about.supportBody"))}</p>
    <p class="tusks-vault-support">${link(SUPPORT_URL, t("dialog.about.supportLink"))}</p>
  </div>`;

  const dialog = new DialogV2({
    window: { title: t("dialog.about.title") },
    content,
    buttons: [{ action: "close", label: t("dialog.about.close"), default: true }],
  });
  await dialog.render({ force: true });

  // Bound after render, because the button lives in the dialog's own markup
  // rather than in its button row — a DialogV2 button would close the window,
  // and closing the window is the opposite of what "copy this so you can paste
  // it" wants.
  const root = dialog.element;
  root?.querySelector?.(".tusks-vault-copy-diagnostics")?.addEventListener?.("click", async () => {
    const text = TusksVault.diagnostics();
    try {
      await navigator.clipboard.writeText(text);
      ui.notifications?.info?.(t("dialog.about.copied"));
    } catch {
      // Clipboard access needs a secure context, which a plain-HTTP Foundry is
      // not. Saying where the text already is beats failing silently.
      ui.notifications?.warn?.(t("dialog.about.copyFailed"));
    }
  });
  return dialog;
}

/**
 * Point lite at the notes the GM already has.
 *
 * A checkbox per journal folder, the same shape as the allow list and for the
 * same reason: the stored value is an id nobody can read or type.
 *
 * The named lore folder is shown first and cannot be unticked here — it is the
 * one the folder SETTING names, and two controls that can each switch the same
 * folder off is a way to end up with an empty corpus and no idea which of them
 * did it.
 */
async function openFolderPicker() {
  if (!game.user.isGM) {
    ui.notifications.warn(t("notify.gmOnlyKey"));
    return;
  }
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) {
    ui.notifications.error(t("notify.allowListUnavailable"));
    return;
  }

  const primary = loreFolder();
  const chosen = new Set(Array.isArray(setting("liteExtraFolders")) ? setting("liteExtraFolders") : []);
  const folders = (game.folders?.filter?.(f => f.type === "JournalEntry") ?? [])
    .filter(f => f.id !== primary?.id)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  // How many entries each folder holds, so the GM is choosing between things
  // rather than between names. A folder with nothing in it is the commonest
  // thing to tick by mistake.
  const counts = new Map();
  for (const entry of game.journal?.filter?.(() => true) ?? []) {
    const id = entry.folder?.id ?? entry.folder ?? null;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const rows = folders
    .map(folder => `<label class="tusks-vault-allow-row">
      <input type="checkbox" name="tusks-vault-folder" value="${escapeHtml(folder.id)}"${chosen.has(folder.id) ? " checked" : ""}>
      <span class="tusks-vault-allow-name">${escapeHtml(folder.name ?? folder.id)}</span>
      <span class="tusks-vault-allow-role">${escapeHtml(t("dialog.folders.count", { count: counts.get(folder.id) ?? 0 }))}</span>
    </label>`)
    .join("");

  const primaryLine = primary
    ? t("dialog.folders.primary", { folder: primary.name })
    : t("dialog.folders.noPrimary", { folder: setting("liteFolder") || LITE_DEFAULT_FOLDER });

  const body = folders.length === 0
    ? `<p class="notes">${escapeHtml(t("dialog.folders.none"))}</p>`
    : `<div class="tusks-vault-allow-list">${rows}</div>`;

  const dialog = new DialogV2({
    window: { title: t("dialog.folders.title") },
    content: `<div class="tusks-vault-allow">
      <p>${escapeHtml(t("dialog.folders.body"))}</p>
      <p class="notes">${escapeHtml(primaryLine)}</p>
      ${body}
      <p class="notes">${escapeHtml(t("dialog.folders.note"))}</p>
    </div>`,
    buttons: [
      {
        action: "save",
        label: t("dialog.folders.save"),
        default: true,
        callback: (_event, button, dlg) => {
          const root = dlg?.element ?? dlg ?? button?.form ?? null;
          const picked = [...(root?.querySelectorAll?.('input[name="tusks-vault-folder"]:checked') ?? [])]
            .map(input => input.value);
          setSetting("liteExtraFolders", picked)
            .then(() => ui.notifications.info(t("notify.foldersSaved", { count: picked.length })))
            .catch(err => ui.notifications.error(t("notify.keyFailed", { detail: err?.message ?? String(err) })));
        },
      },
      { action: "cancel", label: t("dialog.folders.cancel") },
    ],
  });
  void Promise.resolve(dialog.render({ force: true })).catch(err => {
    // An ApplicationV2 render can reject, and an un-awaited rejection is an
    // unhandled one: the dialog silently never appears and nothing says why.
    warn("a dialog could not be rendered", err);
    ui.notifications?.error?.(t("notify.dialogFailed"));
  });
  return dialog;
}

/**
 * The questions that actually get asked, and where each one is answered.
 *
 * Not a substitute for the documentation — a route into it. A GM whose command
 * is not working is inside Foundry, mid-session, and is not going to go and
 * find a repository; the shortest useful path is a list that names their
 * symptom in the words they would use and then hands them the page.
 *
 * Every link is checked by `test/module.test.mjs` against the table in
 * `docs/DocsLinks.md`, because these ship compiled into a release and a dead
 * one is a dead end with no redirect to save it.
 */
const FAQ_ENTRIES = [
  { id: "notCommand", href: `${MODULE_REPO}/blob/main/docs/Troubleshooting.md#foundry-says-the-command-is-not-valid` },
  { id: "nothing", href: `${MODULE_REPO}/blob/main/docs/Troubleshooting.md#nothing-happens-or-the-question-just-sits-there` },
  { id: "noMatches", href: `${MODULE_REPO}/blob/main/docs/Lite.md#the-folder` },
  { id: "otherFolder", href: `${MODULE_REPO}/blob/main/docs/Lite.md#the-folder` },
  { id: "players", href: `${MODULE_REPO}/blob/main/docs/Lite.md#only-the-gms-browser-ever-holds-the-key` },
  { id: "key", href: `${MODULE_REPO}/blob/main/docs/Lite.md#what-a-key-in-the-browser-means` },
  { id: "keySafe", href: `${MODULE_REPO}/blob/main/SECURITY.md` },
  { id: "spoilers", href: `${MODULE_REPO}/blob/main/docs/Settings.md#what-each-answer-may-draw-on` },
  { id: "playerNotes", href: `${MODULE_REPO}/blob/main/docs/Lite.md#letting-players-add-their-own-lore` },
  { id: "hosted", href: `${MODULE_REPO}/blob/main/docs/Hosting.md` },
  { id: "cost", href: `${DOCS_SITE}docs/about/what-it-costs/` },
  { id: "difference", href: `${DOCS_SITE}` },
];

async function openFaq() {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) {
    ui.notifications.error(t("notify.allowListUnavailable"));
    return;
  }

  const items = FAQ_ENTRIES.map(entry => `<details class="tusks-vault-faq-item">
      <summary>${escapeHtml(t(`faq.${entry.id}.q`))}</summary>
      <p>${escapeHtml(t(`faq.${entry.id}.a`))}</p>
      <p class="tusks-vault-faq-link"><a href="${entry.href}">${escapeHtml(t("dialog.faq.more"))}</a></p>
    </details>`).join("");

  const dialog = new DialogV2({
    window: { title: t("dialog.faq.title") },
    content: `<div class="tusks-vault-faq">
      <p>${escapeHtml(t("dialog.faq.body"))}</p>
      ${items}
      <p class="notes">${escapeHtml(t("dialog.faq.footer"))}</p>
      <p class="tusks-vault-faq-link">
        <a href="${MODULE_REPO}/blob/main/docs/Troubleshooting.md">${escapeHtml(t("dialog.faq.allDocs"))}</a> ·
        <a href="${MODULE_REPO}/issues">${escapeHtml(t("dialog.faq.issues"))}</a>
      </p>
    </div>`,
    buttons: [{ action: "close", label: t("dialog.faq.close"), default: true }],
  });
  void Promise.resolve(dialog.render({ force: true })).catch(err => {
    // An ApplicationV2 render can reject, and an un-awaited rejection is an
    // unhandled one: the dialog silently never appears and nothing says why.
    warn("a dialog could not be rendered", err);
    ui.notifications?.error?.(t("notify.dialogFailed"));
  });
  return dialog;
}

/**
 * Who can be answered from what, as a table.
 *
 * The alternative to this screen is a paragraph in the documentation telling a
 * GM to go and check their journal permissions by hand, which is advice rather
 * than a tool. Per-asker scoping and player-authored notes both make ownership
 * load-bearing — a page's ownership now decides what the archivist will say to
 * whom — and ownership is the one thing about a journal that is invisible from
 * the sidebar.
 *
 * Reports Foundry's ownership rather than editing it. A second place to change
 * permissions is a second place for them to disagree.
 */
async function openLorePermissions() {
  if (!game.user.isGM) {
    ui.notifications.warn(t("notify.gmOnlyKey"));
    return;
  }
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) {
    ui.notifications.error(t("notify.allowListUnavailable"));
    return;
  }

  const folderName = setting("liteFolder") || LITE_DEFAULT_FOLDER;
  const players = game.users?.filter?.(u => !u.isGM) ?? [];
  const folderIds = loreFolderIds();
  const entries = folderIds
    ? (game.journal?.filter?.(e => folderIds.has(e.folder?.id ?? e.folder)) ?? [])
    : [];

  const rows = [];
  for (const entry of entries) {
    for (const page of [...(entry.pages?.contents ?? entry.pages ?? [])]) {
      if (!journalText(page?.text?.content ?? "")) continue;
      const readers = players.filter(player => mayRead(player, page, entry));
      rows.push({ name: pageName(entry, page), readers: readers.length, total: players.length });
    }
  }

  const describe = row => {
    if (row.total === 0 || row.readers === 0) return t("dialog.perms.gmOnly");
    if (row.readers === row.total) return t("dialog.perms.everyone");
    return t("dialog.perms.some", { count: row.readers, total: row.total });
  };
  const kind = row => (row.readers === 0 ? "gm" : row.readers === row.total ? "all" : "some");

  const body = rows.length === 0
    ? `<p>${escapeHtml(t("dialog.perms.empty", { folder: folderName }))}</p>`
    : `<table class="tusks-vault-perms-table">
        <thead><tr>
          <th>${escapeHtml(t("dialog.perms.colPage"))}</th>
          <th>${escapeHtml(t("dialog.perms.colWho"))}</th>
        </tr></thead>
        <tbody>${rows
          .sort((a, b) => a.readers - b.readers || a.name.localeCompare(b.name))
          .map(row => `<tr class="is-${kind(row)}">
            <th scope="row">${escapeHtml(row.name)}</th>
            <td>${escapeHtml(describe(row))}</td>
          </tr>`)
          .join("")}</tbody>
      </table>`;

  const writers = players.filter(u => u.hasPermission?.("JOURNAL_CREATE"));
  const writerNote = writers.length > 0
    ? `<p class="notes">${escapeHtml(t("dialog.perms.writable", { count: writers.length }))}</p>`
    : "";

  const dialog = new DialogV2({
    window: { title: t("dialog.perms.title") },
    content: `<div class="tusks-vault-perms">
      <p>${escapeHtml(t("dialog.perms.body", { folder: folderName }))}</p>
      ${body}
      <p class="notes">${escapeHtml(t("dialog.perms.scopeNote", {
        scope: t(`settings.liteScope.${setting("liteScope") || "asker"}`),
      }))}</p>
      ${writerNote}
    </div>`,
    buttons: [{ action: "close", label: t("dialog.perms.close"), default: true }],
  });
  void Promise.resolve(dialog.render({ force: true })).catch(err => {
    // An ApplicationV2 render can reject, and an un-awaited rejection is an
    // unhandled one: the dialog silently never appears and nothing says why.
    warn("a dialog could not be rendered", err);
    ui.notifications?.error?.(t("notify.dialogFailed"));
  });
  return dialog;
}

/** A role number as something a person can read. Unknown numbers report
 *  themselves rather than being hidden — a role this module does not know
 *  about is exactly the thing a GM would want to see in the list. */
function roleLabel(role) {
  if (role === ROLES.GAMEMASTER) return t("roles.gamemaster");
  if (role === ROLES.ASSISTANT) return t("roles.assistant");
  if (role === ROLES.TRUSTED) return t("roles.trusted");
  if (role === ROLES.PLAYER) return t("roles.player");
  if (role === ROLES.NONE) return t("roles.none");
  return String(role ?? "?");
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function fetchJson(url, options = {}, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Find Vault on this machine.
 *
 * Probes the bounded port range in parallel and takes the first answer. Note
 * this reaches 127.0.0.1 from a page that may itself be served over HTTPS from
 * a hosted Foundry: browsers treat loopback as a potentially-trustworthy origin
 * and exempt it from mixed-content blocking, which is what makes a hosted
 * Foundry work at all. Safari has historically been stricter — the README says
 * so rather than this failing mysteriously.
 */
async function discoverVault() {
  const candidates = [];
  const configured = (setting("bridgeUrl") || "").trim().replace(/\/+$/, "");
  // A URL the user set by hand is probed alongside the scan — someone running
  // Vault on a non-default port should not have to wait for one.
  //
  // Validated with the same predicate getBridge() uses, rather than trusted.
  // A value that is not an absolute origin resolves against the FOUNDRY page,
  // so `vault` or `:3000` would send `GET /vault/api/mcp/hello` to Foundry
  // itself — the precise failure isVaultAddress() was written to prevent, one
  // layer above where it was being applied.
  if (configured && isVaultAddress(configured)) candidates.push(configured);
  for (let i = 0; i < DISCOVERY_PORT_COUNT; i += 1) {
    const url = `http://127.0.0.1:${DISCOVERY_BASE_PORT + i}`;
    if (url !== configured) candidates.push(url);
  }

  const probes = candidates.map(async base => {
    const res = await fetchJson(`${base}/api/mcp/hello`);
    if (!res.ok || res.body?.app !== "tusks-vault") throw new Error("not vault");
    return { base, hello: res.body };
  });

  try {
    // First match wins. Promise.any ignores the failures, which is every port
    // that is closed or running something else.
    const found = await Promise.any(probes);
    record("info", "TV-DISCOVER-OK", `found Vault at ${found.base}`);
    return found;
  } catch {
    record("error", "TV-DISCOVER-NONE", `no Vault on ${candidates.length} candidate address(es)`, {
      scanned: DISCOVERY_RANGE_LABEL,
      configured: configured || "(none)",
    });
    return null;
  }
}

// ─── Pairing ─────────────────────────────────────────────────────────────────

/**
 * The one-click handshake.
 *
 * Vault shows a code beside Allow/Deny; Foundry shows the same code. The user
 * confirms they match and clicks Allow. The code is what makes the approval
 * SPECIFIC — without it, a page firing its own pair request at the same moment
 * would be indistinguishable from this one.
 */
async function runPairing() {
  if (!game.user.isGM) {
    ui.notifications.warn(t("notify.gmOnlyPairing"));
    return;
  }

  record("info", "TV-PAIR-START", "pairing requested");
  ui.notifications.info(t("notify.searching"));
  const found = await discoverVault();
  if (!found) {
    // The scanned range goes IN the message. Telling a GM to "check it is
    // running" when it demonstrably is running — just on a port outside the
    // scan — is a dead end, and the one setting that fixes it is the one
    // thing the message has to name.
    ui.notifications.error(t("notify.notFound", { range: DISCOVERY_RANGE_LABEL }));
    return;
  }

  const { base, hello } = found;
  if (!Array.isArray(hello.protocolVersions) || !hello.protocolVersions.includes(PROTOCOL_VERSION)) {
    // The module and Vault version independently now that the module ships
    // through Foundry's registry, so this mismatch is expected eventually.
    ui.notifications.error(t("notify.protocolMismatch", { version: hello.version ?? "?" }));
    return;
  }

  const requested = await fetchJson(
    `${base}/api/mcp/pair/request`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        surface: "foundry",
        clientName: "Foundry VTT",
        worldTitle: game.world?.title ?? "",
        foundryVersion: game.version ?? "",
      }),
    },
    10_000
  );

  if (!requested.ok) {
    record("error", `TV-PAIR-${requested.status}`, requested.body?.error ?? "pair request refused", {
      reason: requested.body?.reason ?? "(none)",
    });
    ui.notifications.error(requested.body?.error ?? t("notify.pairFailed"));
    return;
  }

  const { requestId, code } = requested.body;
  const dialog = showCodeDialog(code);

  try {
    const outcome = await pollForToken(base, requestId);
    if (!outcome.token) {
      record("warn", outcome.reason === "denied" ? "TV-PAIR-DENIED" : "TV-PAIR-EXPIRED",
        `pairing ended: ${outcome.reason}`);
      ui.notifications.warn(
        t(outcome.reason === "denied" ? "notify.pairDeclined" : "notify.pairExpired")
      );
      return;
    }
    await setSetting("bridgeUrl", base);
    await setSetting("bridgeToken", outcome.token);
    bridge = null; // force a fresh session on the new credential

    // Prove the credential before claiming it works. Pairing establishes only
    // that Vault will ISSUE a token; everything checked per request — the
    // Foundry surface toggle above all — is not consulted until a real call is
    // made. Skipping this leaves the one confusing step in an otherwise clean
    // setup: the GM is told "paired", asks a question, and gets a failure that
    // reads like the pairing never took.
    try {
      await getBridge().initialize();
      record("info", "TV-PAIR-OK", `paired with ${base} and verified`);
      ui.notifications.info(t("notify.paired"));
    } catch (err) {
      warn("paired, but the first call failed", err);
      ui.notifications.warn(t("notify.pairedButUnusable", { detail: err?.message ?? String(err) }));
    }
  } catch (err) {
    // Vault mints the client the moment Allow is clicked, so a throw AFTER that
    // point leaves the two ends disagreeing: the dashboard lists a paired
    // Foundry, and Foundry has no token. Reported, because that state is
    // indistinguishable from "never paired" from the table's side and the fix
    // (pair again) is not one the GM would guess.
    console.error(`${MODULE_ID} | pairing failed:`, err);
    ui.notifications.error(t("notify.pairError", { detail: err?.message ?? String(err) }));
  } finally {
    dialog?.close?.();
  }
}

/**
 * Poll until the user decides.
 *
 * Returns the token, or WHY there isn't one. A request that lapsed unapproved
 * and a request that was actively refused feel nothing alike to the person who
 * clicked Connect, and telling someone who was merely slow that they were
 * refused sends them looking for a permission problem that does not exist.
 *
 * Two seconds is well inside Vault's read budget for the whole approval window.
 */
async function pollForToken(base, requestId) {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    // A throwing poll is a blip, not an answer. Letting it escape would end the
    // pairing at the exact moment the user is looking at the code and about to
    // click Allow. Wait for the next tick instead; the deadline still bounds it.
    let res;
    try {
      res = await fetchJson(
        `${base}/api/mcp/pair/status?requestId=${encodeURIComponent(requestId)}`,
        {},
        10_000
      );
    } catch (err) {
      warn("pairing poll failed, retrying", err);
      continue;
    }
    const status = res.body?.status;
    if (status === "approved") return { token: res.body.token ?? null };
    if (status === "denied") return { reason: "denied" };
    // "unknown" means the request Vault is holding is no longer this one —
    // replaced or lapsed. Either way it will never be approved now.
    if (status === "expired" || status === "unknown") return { reason: "expired" };
  }
  return { reason: "expired" };
}

function showCodeDialog(code) {
  const content = `<p>${t("dialog.pairing.body")}</p>
    <p class="tusks-vault-code">${escapeHtml(code)}</p>
    <p class="notes">${t("dialog.pairing.hint")}</p>`;

  // DialogV2 is the v13+ API; the fallback keeps this working if an older
  // shim is in play. Neither is awaited — the dialog is a display, and the
  // pairing loop is what actually decides the outcome.
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (DialogV2) {
    const dialog = new DialogV2({
      window: { title: t("dialog.pairing.title") },
      content,
      buttons: [{ action: "close", label: t("dialog.pairing.close"), default: true }],
    });
    void Promise.resolve(dialog.render({ force: true })).catch(err => {
      // An ApplicationV2 render can reject, and an un-awaited rejection is
      // an unhandled one: the dialog never appears and nothing says why.
      warn("a dialog could not be rendered", err);
      ui.notifications?.error?.(t("notify.dialogFailed"));
    });
    return dialog;
  }
  const legacy = new Dialog({ title: t("dialog.pairing.title"), content, buttons: {} });
  legacy.render(true);
  return legacy;
}

// ─── MCP client ──────────────────────────────────────────────────────────────

/**
 * A hand-rolled MCP client over `fetch`.
 *
 * `initialize`, then `tools/call`, is about fifty lines of JSON-RPC. Bundling
 * an SDK into a Foundry module to make one fixed call would be weight without
 * benefit.
 */
class VaultBridge {
  constructor(base, token) {
    this.base = base;
    this.token = token;
    this.sessionId = null;
  }

  headers() {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }

  async rpc(method, params, timeoutMs) {
    try {
      return await fetchJson(
        `${this.base}/mcp`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ jsonrpc: "2.0", id: foundry.utils.randomID(), method, params }),
        },
        timeoutMs ?? 30_000
      );
    } catch (err) {
      // `fetch` rejects for a refused connection, a DNS failure, or our own
      // abort — never for an HTTP error status, which arrives as an ordinary
      // response. To a GM those mean one of exactly two things, and the browser's
      // own "Failed to fetch" says neither: it sends them to look at their
      // network when the answer is that Vault is not running. This is the most
      // likely first-run fault of all, so it gets the clearest sentence.
      throw new BridgeError(
        0,
        err?.name === "AbortError"
          ? t("chat.timedOut")
          : t("chat.unreachable", { address: this.base }),
        err?.name === "AbortError" ? "TV-BRIDGE-TIMEOUT" : "TV-BRIDGE-UNREACHABLE"
      );
    }
  }

  async initialize() {
    this.sessionId = null;
    const res = await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "foundry-vtt", version: game.version ?? "unknown" },
    });
    if (!res.ok) throw bridgeFailure(res, this.base);

    this.sessionId = res.headers.get("Mcp-Session-Id");
    if (!this.sessionId) {
      // A 200 with no session header means something answered as Vault but is
      // not speaking Streamable HTTP — a proxy in the way, most likely.
      throw new BridgeError(res.status, "Vault did not issue a session.", "TV-BRIDGE-NOSESSION");
    }
    record("info", "TV-BRIDGE-READY", `session opened with ${this.base}`);

    // The handshake is only complete once the client confirms it.
    await this.rpc("notifications/initialized", {});
    return res.body?.result;
  }

  async callTool(name, args, timeoutMs) {
    if (!this.sessionId) await this.initialize();

    let res = await this.rpc("tools/call", { name, arguments: args }, timeoutMs);

    // 404 means the session lapsed — Vault restarted, or it idled out. That is
    // recoverable and invisible to the table, so re-handshake once and retry.
    // Retrying more than once would turn a persistent fault into a loop.
    if (res.status === 404) {
      await this.initialize();
      res = await this.rpc("tools/call", { name, arguments: args }, timeoutMs);
    }

    if (!res.ok) throw bridgeFailure(res, this.base);
    if (res.body?.error) throw new BridgeError(200, res.body.error.message ?? "Vault returned an error.");
    return res.body?.result;
  }
}

/**
 * Turn a failed response into something worth reading.
 *
 * Vault's own errors are `{ error: "..." }` and MCP's are `{ error: { message } }`;
 * anything else means the address answered but is not Vault. Saying so, with
 * the address, is the difference between a two-minute fix and an afternoon —
 * and passing a bare object to `Error` (which the previous code did for the MCP
 * shape) produced the string "[object Object]".
 */
function describeFailure(res, base) {
  const reported = res.body?.error;
  if (typeof reported === "string") return reported;
  if (typeof reported?.message === "string") return reported.message;
  return `${base || "(no address set)"} answered ${res.status}, but not as Tusk's Vault. ` +
    "Check the Vault address in module settings, or pair again.";
}

/**
 * Did this response come from something that is not Vault at all?
 *
 * The same test `describeFailure` makes to choose its wording, named so the
 * caller can ACT on it rather than only report it. Vault answers errors as
 * `{error: "..."}` and MCP as `{error: {message}}`; a response carrying
 * neither came from another server — most often Foundry itself, because the
 * stored address is a well-formed origin pointing at the wrong port.
 */
function answeredButNotVault(res) {
  const reported = res.body?.error;
  return typeof reported !== "string" && typeof reported?.message !== "string";
}

/** One failure object for both call sites, carrying the verdict as well as the
 *  sentence, so a caller can recover instead of only reporting. */
function bridgeFailure(res, base) {
  const err = new BridgeError(res.status, describeFailure(res, base));
  err.wrongAddress = answeredButNotVault(res);
  return err;
}

class BridgeError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code ?? bridgeCode(status);
    record("error", this.code, message);
  }
}

let bridge = null;

/**
 * Is this an address a request can actually be sent to?
 *
 * Emptiness is not the only unusable value, and `fetch` does not complain about
 * the others: anything that is not an absolute origin is resolved against the
 * FOUNDRY page, so `fetch(base + "/mcp")` quietly asks Foundry for the campaign
 * lore. Foundry answers 404 in HTML, which is not JSON, so the error carries no
 * message and the module reports it as Vault refusing the connection. Nothing
 * in that sentence is true, and it sends the GM to look at Vault.
 */
function isVaultAddress(value) {
  return /^https?:\/\/[^/\s]+$/i.test(value);
}

/**
 * The bridge address as a CATEGORY, for the diagnostics dump.
 *
 * A loopback address is reported with its port, because the port is the whole
 * question when discovery fails and the number identifies nobody. Anything else
 * is reported only as "set by hand" — see the call site for why a hostname is
 * not safe to quote into a public issue.
 */
function describeBridgeUrl(raw) {
  const value = (raw || "").trim().replace(/\/+$/, "");
  if (!value) return "(unset — discovery finds it)";
  if (!isVaultAddress(value)) return "(set, but not an absolute origin)";
  if (LOOPBACK_HOST.test(value)) return value;
  return "(set by hand, not loopback)";
}

function getBridge() {
  const base = (setting("bridgeUrl") || "").trim().replace(/\/+$/, "");
  const token = setting("bridgeToken") || "";
  if (!token || !isVaultAddress(base)) return null;
  if (!bridge || bridge.base !== base || bridge.token !== token) {
    bridge = new VaultBridge(base, token);
  }
  return bridge;
}

/**
 * The bridge, re-finding Vault's address if it has gone missing.
 *
 * The address is a settings-form field and the token is not, so the two can
 * drift apart: blanking the field by hand, or saving a settings form that was
 * opened before pairing filled it in, leaves a valid credential with nowhere to
 * send it. The field's own hint promises the address is found automatically
 * when left blank — this makes that true for asking, not only for pairing.
 *
 * Re-discovery is only attempted when a token exists. Without one the module is
 * genuinely unpaired, and probing twenty ports to tell the GM something the
 * pairing prompt already says would just be noise.
 */
async function resolveBridge() {
  const ready = getBridge();
  if (ready) return ready;
  if (!(setting("bridgeToken") || "")) return null;
  return rediscover("address was unusable");
}

/**
 * Re-find Vault and adopt the address, for a caller that has a token.
 *
 * Split out of resolveBridge because there are two ways a stored address goes
 * bad and only one of them is visible before a call is made.
 */
async function rediscover(why) {
  const found = await discoverVault();
  if (!found) return null;
  record("warn", "TV-ADDR-RECOVERED", `${why}; re-discovered ${found.base}`);
  await setSetting("bridgeUrl", found.base);
  bridge = null; // the cached bridge still holds the old address
  log(`re-discovered Vault at ${found.base}`);
  return getBridge();
}

/**
 * Run a bridge call, and if the stored address turns out not to be Vault, find
 * Vault and run it once more.
 *
 * The gap this closes: getBridge() rejects an address that is not a well-formed
 * origin, and resolveBridge() re-discovers when it does. But the address that
 * actually breaks a table is well-formed and simply WRONG — most often Foundry's
 * own origin, which answers every request with a 404 that is not Vault's JSON.
 * Nothing about that is visible until a call is made, so the syntactic check
 * passes, the cached bridge is returned, and every question thereafter is
 * politely asked of Foundry.
 *
 * Retried exactly once, and only for `wrongAddress`. A refusal from a Vault
 * that IS Vault — a bad token, a switched-off surface — is not an address
 * problem, and re-probing twenty ports on every such failure would turn one
 * clear error into a slow one.
 */
async function callWithAddressRecovery(activeBridge, name, args, timeoutMs) {
  try {
    return await activeBridge.callTool(name, args, timeoutMs);
  } catch (err) {
    if (!err?.wrongAddress) throw err;
    const recovered = await rediscover(`${activeBridge.base} is not Vault`);
    if (!recovered) throw err;
    return recovered.callTool(name, args, timeoutMs);
  }
}

// ─── Lite mode ───────────────────────────────────────────────────────────────
//
// The front door. Everything here answers a question WITHOUT Tusk's Vault
// installed, from journal entries the GM already keeps, so somebody can try the
// idea before downloading anything.
//
// It is deliberately the smaller half of a ladder:
//
//   Layer 1  search   no key, no network, no cost. Finds the passage.
//   Layer 2  answers  the GM's own Gemini key, in this browser. Writes prose.
//   Vault             the key never touches a browser, plus everything else.
//
// LAYER 1 IS THE DEFAULT AND NEEDS NO CREDENTIAL. That is not a limitation
// dressed up as a feature: a module that holds no secret and calls nothing
// external is a module a stranger can install without trusting anybody, and
// the risk in layer 2 is then something they opt into knowing why.
//
// THE ONE RULE THIS SECTION MUST NOT BREAK: `answerLocally` returns the SAME
// SHAPE as Vault's `ask_lore` tool result. Everything downstream — the access
// policy, the whisper targets, the placeholder, the citation chips, the error
// codes, the diagnostics — is the bridge's, untouched, and stays that way
// because lite hands it something it already knows how to render.

/** The folder whose journal entries are the corpus. */
const LITE_DEFAULT_FOLDER = "Tusk's Lore";

/** Gemini, and only Gemini. It has a free tier, which is the difference
 *  between a front door and a form asking for billing details. Every other
 *  provider — and OpenRouter's routing — is Vault's. */
const LITE_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/** How much corpus goes into one question. The cap is the honest limit of a
 *  browser holding a whole campaign in a single prompt — and it is also the
 *  moment to say that Vault indexes instead. */
const LITE_CORPUS_CHAR_CAP = 120_000;
const LITE_SEARCH_RESULTS = 5;
const LITE_TIMEOUT_MS = 120_000;

/** Said to the model, in the prompt, when a document had to be cut short — so
 *  a fragment cannot be mistaken for the whole record by the one reader who
 *  cannot check. */
const TRUNCATION_MARKER = "\n[… this document was too long to include in full; the rest was not read.]";

/**
 * The citation contract, and the reason to keep it in one piece.
 *
 * These rules are what make an answer checkable rather than plausible, and
 * they are Vault's, restated here because lite has no Vault to ask. THEY MUST
 * STAY IN STEP with Vault's `src/server/prompt/system.ts` — if the two drift,
 * the same question answered through the two paths cites differently, and
 * nothing fails until a user notices an uncited claim.
 *
 * Bump the version when the rules change on either side.
 */
const LORE_CONTRACT_VERSION = "1";
const LITE_SYSTEM_PROMPT = [
  "You are an archivist answering questions about a tabletop campaign from the documents supplied below, and nothing else.",
  "",
  "1. SOURCE ADHERENCE — Every factual claim about the world must end with a citation marker naming the document it came from, written as [Document Name] using the exact name from the [SOURCE: ...] header. If you cannot cite a source for a claim, you do not know that claim.",
  "2. NO INVENTION — If the answer is not in the supplied documents, emit this exact phrase and nothing else: \"I am unsure about this detail. I have recorded this as a lore gap for the DM to clarify.\"",
  "3. NO OUTSIDE KNOWLEDGE — Do not fall back on general fantasy or game-rules knowledge to fill a gap in these documents.",
  "4. TONE — Answer plainly and briefly. Two or three sentences unless the question genuinely needs more.",
].join("\n");

/**
 * Gemini's per-call safety filters, and why they are off by default.
 *
 * A campaign archive is asked about war, murder, torture and worse, because
 * that is what the documents contain. Google's default thresholds refuse a
 * fair amount of ordinary dark-fantasy material, and a refusal here is
 * indistinguishable to a GM from the archive not knowing — which is exactly
 * the failure the citation rules exist to prevent.
 *
 * Gemini is the only provider of the three with an API-level toggle for this;
 * Anthropic and OpenAI bake refusals into training and expose no per-call
 * equivalent. Tusk's Vault sends the same four categories at the same default
 * (`src/server/llm/gemini.ts`), with per-category tightening; lite has one
 * switch instead, which is the bare-bones version of the same decision.
 *
 * The switch matters because a lite answer lands in a chat log the whole table
 * reads. A GM whose table wants filters can have them.
 */
const LITE_SAFETY_CATEGORIES = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
];

function buildSafetySettings(filtered) {
  const threshold = filtered ? "BLOCK_MEDIUM_AND_ABOVE" : "BLOCK_NONE";
  return LITE_SAFETY_CATEGORIES.map(category => ({ category, threshold }));
}

/** Vault's lore-gap phrase, matched loosely the way Vault matches it, so a
 *  lite answer marks the card the same way a Vault answer does. */
const LITE_LORE_GAP_FRAGMENT = "i am unsure about this detail";

// ─── The corpus ──────────────────────────────────────────────────────────────

/** The lore folder, or null when the GM has not made one yet. */
function loreFolder() {
  const name = (setting("liteFolder") || LITE_DEFAULT_FOLDER).trim().toLowerCase();
  const matches = game.folders?.filter?.(f => f.type === "JournalEntry" && String(f.name).trim().toLowerCase() === name) ?? [];
  // TWO FOLDERS OF THE SAME NAME is silently taking the first one, and the
  // symptom — "it is not reading my notes" — points at nothing a GM can see.
  // Foundry allows the duplicate, so this cannot be prevented, only reported.
  if (matches.length > 1) {
    record("warn", "TV-LITE-FOLDER-AMBIGUOUS", "more than one journal folder has the lore folder's name; reading the first", {
      folders: matches.length,
    });
  }
  return matches[0] ?? null;
}

/**
 * Every folder in the lore tree — the named one, and everything nested inside it.
 *
 * Until 1.1.0 only direct children counted, and the failure was a dead end
 * rather than a degradation: a GM who had organised their notes into
 * `Tusk's Lore / NPCs` and `Tusk's Lore / Sessions` got an EMPTY corpus and an
 * error telling them to create a folder they had visibly already created.
 * Organising notes into subfolders is the ordinary thing to do with a folder,
 * so the fix is to read the tree rather than to warn about it.
 *
 * Walks until nothing new is added rather than recursing to a fixed depth:
 * Foundry nests folders arbitrarily, and a `Set` makes the loop terminate even
 * if a cycle somehow exists in a hand-edited world.
 */
function loreFolderIds() {
  const all = game.folders?.filter?.(f => f.type === "JournalEntry") ?? [];
  const ids = new Set();

  const root = loreFolder();
  if (root) ids.add(root.id);

  // Folders the GM picked out of what they already had.
  //
  // This is the wall a new install actually hits. The welcome screen makes the
  // lore folder, and then the GM is looking at the notes they have kept for two
  // years — "NPCs", "Session Notes", whatever the adventure they bought came
  // with — and the only documented way forward is to move or retype all of it
  // into a new folder. Most people stop there, and reasonably: reorganising a
  // campaign to suit a module is a bad trade.
  //
  // Reading folders they already have costs them nothing and gives up nothing
  // that belongs to the full application, which reads notes that are not in
  // Foundry at all.
  const extras = setting("liteExtraFolders");
  if (Array.isArray(extras)) {
    for (const id of extras) if (typeof id === "string" && all.some(f => f.id === id)) ids.add(id);
  }

  if (ids.size === 0) return null;

  // Subfolders, to any depth. Walks until nothing new is added rather than
  // recursing to a fixed depth: Foundry nests folders arbitrarily, and a `Set`
  // makes the loop terminate even if a cycle somehow exists in a hand-edited
  // world.
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of all) {
      const parent = folder.folder?.id ?? folder.folder ?? null;
      if (parent && ids.has(parent) && !ids.has(folder.id)) {
        ids.add(folder.id);
        grew = true;
      }
    }
  }
  return ids;
}

/**
 * Journal page content is stored as HTML. Reduce it to the text a model should
 * read — and note this runs BEFORE anything is put in a prompt, not before it
 * is put on screen, so it is not a security boundary. `escapeHtml` is what
 * guards the chat log, and it still does.
 */
function journalText(html) {
  return String(html ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#x27|#39|nbsp);/gi, m => (m.toLowerCase() === "&nbsp;" ? " " : HTML_ENTITIES[m.toLowerCase()] ?? m))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * May this person read this page?
 *
 * THE PAGE IS THE UNIT, NOT THE ENTRY, and that is a correctness fix rather
 * than a refinement. Foundry pages carry their own ownership:
 * `BaseJournalEntryPage` initialises the field to INHERIT, and
 * `Document#getUserLevel` returns a page's own level whenever it is not
 * INHERIT, deferring to the parent entry only when it is.
 *
 * So asking the entry — which is what this did until 1.1.0 — was wrong in both
 * directions. A GM-only page inside a shared entry had its text put into a
 * player's corpus, which is precisely the leak the filter exists to prevent
 * and precisely what the documentation promised could not happen. And a page
 * shared with one player inside an otherwise hidden entry was excluded, which
 * is the player-authored-backstory case.
 *
 * Asking the page gets both right, because Foundry already walks to the parent
 * for us.
 *
 * OBSERVER rather than LIMITED: a limited-ownership document shows its name and
 * nothing else, and answering from something somebody may only see the name of
 * is the same leak one step quieter.
 */
function mayRead(reader, page, entry) {
  // FAIL CLOSED on a missing reader too. This used to return `true`, on the
  // reasoning that every call site filters nulls before calling — which was
  // true, and is exactly the kind of guarantee that stops being true one
  // refactor later. A permission predicate whose first line admits everything
  // is one missing null-check away from being the leak it exists to prevent.
  if (!reader) return false;
  try {
    if (typeof page?.testUserPermission === "function") return page.testUserPermission(reader, "OBSERVER") === true;
    // A page that cannot answer for itself defers to its entry. Nothing Foundry
    // ships lands here; a hand-built document or a very old world might, and
    // falling through to "allowed" would turn a missing method into a leak.
    if (typeof entry?.testUserPermission === "function") return entry.testUserPermission(reader, "OBSERVER") === true;
    return true;
  } catch (err) {
    // FAIL CLOSED, and do not let one document take the answer down with it.
    //
    // This is a permission check, so an exception must mean "no" — the
    // alternative is a document whose ownership could not be evaluated being
    // treated as readable. And without the catch, one broken page in a folder
    // threw out of `collectLore` and the GM got an error card instead of an
    // answer assembled from the other ninety-nine.
    warn("a document could not answer whether it may be read; excluding it", err);
    record("warn", "TV-LITE-PERM-FAIL", err?.message ?? String(err));
    return false;
  }
}

/**
 * What a citation says — and what it has to be able to do.
 *
 * A citation is this module's central promise: click through and check, rather
 * than take the archivist's word for it. That promise needs the name to
 * identify something a reader can actually find. A campaign's NPC notes are
 * routinely one entry of forty-odd pages, and `[NPCs]` leaves the reader
 * searching all of it by hand; `[NPCs: <the page>]` names the page, and the
 * link built from it opens the journal AT that page.
 *
 * The single-page case is collapsed because Foundry names a lone page after its
 * entry by default, and `Harbour Master: Harbour Master` reads as a bug.
 */
function pageName(entry, page) {
  const entryName = String(entry?.name ?? "Untitled").trim() || "Untitled";
  const pageTitle = String(page?.name ?? "").trim();
  // Collapse ONLY when the page repeats its entry, which is what Foundry names
  // the first page of a new entry and would otherwise read as a bug:
  // "Harbour Master: Harbour Master".
  //
  // Deliberately NOT collapsed for a single page named something of its own.
  // That rule was here and it was wrong: an entry "Player Backstories" holding
  // one page "Rhian" was cited as "Player Backstories", which is the entry the
  // reader already knew about and not the page they wanted. Losing the page
  // name costs more than the occasional verbose "Session 07: Quest Details".
  if (!pageTitle || pageTitle === entryName) return entryName;
  return `${entryName}: ${pageTitle}`;
}

/**
 * Everyone whose view has to agree before a page counts as shared.
 *
 * Only the non-GM users, because a GM sees everything and including one would
 * make the intersection meaningless. Falls back to the asker when a world has
 * no players at all — an intersection over nobody is "everything", and
 * defaulting a scope setting into showing everything is the one outcome it
 * exists to prevent.
 */
function tableAudience(asker) {
  const players = game.users?.filter?.(u => !u.isGM) ?? [];
  return players.length > 0 ? players : [asker].filter(Boolean);
}

/**
 * Who this answer is allowed to have been assembled for.
 *
 * `null` means no filter at all, which is only ever correct for the GM-wide
 * scope — the relay has already established that it is itself the active GM,
 * and a GM's own view is everything.
 */
const LITE_SCOPES = new Set(["all", "shared", "asker"]);
let warnedScopeUnknown = false;

/**
 * The scope this world is actually on — the single reading of `liteScope` that
 * everything else asks.
 *
 * AN EMPTY SETTING AND AN UNRECOGNISED ONE ARE NOT THE SAME THING. Empty means
 * never set, which is the documented default: `all`. Unrecognised means a value
 * nobody can account for — a hand-edited world, a half-finished migration, a
 * setting written by a version that is not this one.
 *
 * Both used to fall through to `all`, so any corrupt string silently turned the
 * ownership filter OFF. That is a usability rule — "an unknown value should
 * behave like the documented default" — applied to a security control, and it
 * is the wrong way round: a value that cannot be read is a reason to show less,
 * not more. Unknown now resolves to `shared`, the safest mode that still
 * answers, and says so once rather than once per question.
 */
function currentScope() {
  const raw = setting("liteScope");
  if (raw === undefined || raw === null || raw === "") return "all";
  const scope = String(raw);
  if (LITE_SCOPES.has(scope)) return scope;
  if (!warnedScopeUnknown) {
    warnedScopeUnknown = true;
    record("warn", "TV-LITE-SCOPE-UNKNOWN", "unrecognised lore scope; reading only what the table can open", { scope });
  }
  return "shared";
}

function loreAudience(asker) {
  const scope = currentScope();
  if (scope === "shared") return tableAudience(asker);
  if (scope === "asker") return [asker].filter(Boolean);
  // `all` ALONE means no filter, and the relay has already established that it
  // is itself the active GM.
  return null;
}

/** Is the archivist reading Foundry's ownership at all? Everything that treats
 *  an answer as narrow depends on this being true. */
function scopingIsOn() {
  const scope = currentScope();
  return scope === "asker" || scope === "shared";
}

/**
 * The two ways a lore folder can expose something, counted.
 *
 * `writable` — pages a non-GM can EDIT. A note in the folder is not merely
 * quoted: its text goes INTO the prompt, so whoever can edit it is writing
 * instructions the model reads next to the archivist's own.
 *
 * `unreadable` — pages some player cannot OPEN in Foundry. Under `all` those
 * are quoted to that player anyway, which is exactly what `all` means.
 *
 * Counting is separate from warning because the two numbers matter under
 * different scopes, and because a count is worth having without a banner
 * attached to it.
 */
function countLoreExposure() {
  const folderIds = loreFolderIds();
  if (!folderIds) return null;
  const players = game.users?.filter?.(u => !u.isGM) ?? [];
  if (players.length === 0) return null;

  // OWNER, not OBSERVER: being able to READ a lore note is the ordinary case
  // and the whole point of the folder. Being able to WRITE one is what puts
  // text of somebody else's choosing into the prompt.
  const owns = (user, doc) => doc?.testUserPermission?.(user, "OWNER") === true;
  let writable = 0;
  let unreadable = 0;
  for (const entry of game.journal?.filter?.(e => folderIds.has(e.folder?.id ?? e.folder)) ?? []) {
    const pages = [...(entry.pages?.contents ?? entry.pages ?? [])];
    if (players.some(p => owns(p, entry) || pages.some(page => owns(p, page)))) writable += 1;
    // `mayRead` is the same predicate the scoped modes filter on, so this
    // counts exactly the pages those modes would have withheld.
    unreadable += pages.filter(page => players.some(p => !mayRead(p, page, entry))).length;
  }
  return { writable, unreadable };
}

/**
 * Warn a GM about what the current scope is actually doing.
 *
 * WHAT THIS CHECKS CHANGED WHEN THE DEFAULT DID. It used to ask whether players
 * *could* create journals, which was reasonable when the wide scope was a
 * deliberate opt-in and is useless now that it is the default: Foundry grants
 * `JOURNAL_CREATE` to Trusted and above, so that test fires on ordinary worlds
 * where nothing is wrong, and a warning that cries wolf is one nobody reads on
 * the day it matters. So it asks the precise questions instead — is there a
 * page in the folder a non-GM can edit, and is there one they cannot read.
 */
function warnIfScopeIsWideOpen() {
  // BOTH warnings are the GM's, and neither is a player's to act on. `onChange`
  // fires on every connected client and `TusksVault.checkScope` is reachable by
  // anyone, so without this a player is shown a permanent banner counting how
  // much of the GM's folder they are not allowed to open.
  if (!game.user?.isGM) return false;

  // WHICH WARNING APPLIES DEPENDS ON THE SCOPE, and they are not the same set.
  //
  // The read warning is about `all` alone: the other two modes filter on
  // exactly the predicate it counts, so under them the number is always zero.
  //
  // The write warning is about everything EXCEPT `asker`. That is the fix to a
  // real gap — this used to return early for ANY scoping mode, so `shared` got
  // silence. Injection is contained by construction under `asker` only, where
  // the corpus assembled for a player holds just what that player could already
  // open, so a planted note can only talk to its own author about their own
  // material. Under `shared`, a page every player can read sits in EVERY
  // asker's prompt — and a page a player can read is precisely the kind they
  // are most likely to have been granted ownership of.
  const scope = currentScope();
  const watchRead = scope === "all";
  const watchWrite = scope !== "asker";
  if (!watchRead && !watchWrite) return false;

  const counts = countLoreExposure();
  if (!counts) return false;
  const writable = watchWrite ? counts.writable : 0;
  const unreadable = watchRead ? counts.unreadable : 0;

  // THE READ CASE, which is the one the shipped default actually creates.
  //
  // Until 1.1.1 this asked only about WRITE access — the prompt-injection
  // precondition — so a GM whose folder was perfectly locked down got silence
  // while every answer quoted pages their players cannot open. The warning
  // existed and did not cover the thing that was happening.
  //
  // It is not a defect being reported. Reading the whole folder is what `all`
  // means, and it is the default for a good reason: Foundry starts every
  // journal at `{default: NONE}`, so scoping out of the box answers "I could
  // not find anything" to everything. But a GM cannot weigh a trade-off nobody
  // has put a number on, and this is the number.
  if (unreadable > 0) {
    record("warn", "TV-LITE-SCOPE-UNREADABLE", "answers may quote pages some players cannot open", {
      unreadablePages: unreadable,
    });
    ui.notifications?.warn?.(t("notify.scopeUnreadable", { count: unreadable }), { permanent: true });
  }

  if (writable > 0) {
    record("warn", "TV-LITE-SCOPE-WIDE", "every answer reads the whole folder, and players can edit part of it", {
      writableEntries: writable,
    });
    ui.notifications?.warn?.(t("notify.scopeWideOpen", { count: writable }), { permanent: true });
  }

  return unreadable > 0 || writable > 0;
}

/**
 * The documents this asker is allowed to have answered from.
 *
 * Filtered by Foundry's own ownership — per asker by default, which is
 * per-player lore scoping, and the one thing this half does that the full
 * application structurally cannot. Vault reads files on disk, and a file
 * carries no notion of who at your table may read it; a journal page carries
 * permissions the GM already maintains for other reasons.
 *
 * The GM's own client assembles this, so it must ask about the ASKER rather
 * than about itself — `game.user` here is the relay, not the person who typed.
 *
 * Each document carries `shared`, meaning every player could read it. Nothing
 * here uses that; the relay does, to notice when an answer drawn from private
 * material is about to be posted to the whole table.
 */
function collectLore(asker) {
  const folderIds = loreFolderIds();
  if (!folderIds) return [];
  const entries = game.journal?.filter?.(e => folderIds.has(e.folder?.id ?? e.folder)) ?? [];
  const audience = loreAudience(asker);
  const players = tableAudience(asker);
  const docs = [];
  for (const entry of entries) {
    const pages = entry.pages?.contents ?? entry.pages ?? [];
    for (const page of [...pages]) {
      // `null` IS THE ONLY VALUE THAT MEANS "NO FILTER". An empty array is not
      // the same thing, and `[].every(...)` is `true` — so an audience that came
      // out empty used to admit every page in the folder, turning per-asker
      // scoping into no scoping at exactly the moment the asker went missing.
      // Empty now means nobody, which is what it says.
      if (audience !== null && (audience.length === 0 || !audience.every(reader => mayRead(reader, page, entry)))) continue;
      const text = journalText(page?.text?.content ?? "");
      // Image, video and PDF pages reduce to nothing. Skipping them keeps a
      // named-but-empty document out of the ranking, where it would match on
      // its title and then contribute no passage to cite.
      if (!text) continue;
      docs.push({
        name: pageName(entry, page),
        uuid: page?.uuid ?? entry.uuid,
        shared: players.every(reader => mayRead(reader, page, entry)),
        text,
      });
    }
  }
  return docs;
}

// ─── Layer 1: search ─────────────────────────────────────────────────────────

/** Words worth matching on. Short and very common words are dropped, because
 *  scoring "the" ranks the longest document first every time. */
function searchTerms(question) {
  const stop = new Set(["the", "and", "for", "who", "what", "where", "when", "why", "how", "was", "are", "with", "that", "this", "does", "did", "has", "have", "from", "about", "into", "them", "they"]);
  return [...new Set(
    String(question ?? "")
      .toLowerCase()
      .split(/[^a-z0-9'-]+/)
      .filter(w => w.length > 2 && !stop.has(w))
  )];
}

/**
 * Rank documents against the question.
 *
 * Term frequency with a length correction, not BM25 — a corpus this size does
 * not justify the maths, and a scorer nobody can predict is worse than a
 * simple one when the user is deciding whether to trust the tool at all.
 */
function rankLore(question, docs) {
  const terms = searchTerms(question);
  if (terms.length === 0) return [];
  return docs
    .map(doc => {
      const haystack = `${doc.name}\n${doc.text}`.toLowerCase();
      let hits = 0;
      let matched = 0;
      for (const term of terms) {
        // `split(term).length - 1` allocates every piece of every document for
        // every term, on the GM's UI thread, once per question. Same count.
        let count = 0;
        for (let i = haystack.indexOf(term); i >= 0; i = haystack.indexOf(term, i + term.length)) count += 1;
        if (count > 0) matched += 1;
        hits += count;
      }
      // Matching MORE OF the question beats matching one word many times: a
      // document naming both the harbour and the master is the one wanted,
      // not the one that says "harbour" twenty times.
      const score = matched * 10 + hits / (1 + Math.log10(1 + doc.text.length));
      return { ...doc, score, matched };
    })
    .filter(d => d.matched > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * Where in `text` the question first matches, or -1.
 *
 * `String#toLowerCase` IS NOT LENGTH-PRESERVING for every input — U+0130, the
 * Turkish dotted capital I, is one code unit and folds to two — so an index
 * found in the folded copy can name a different character in the original, and
 * every slice after it shifts. Rather than mis-slice, a fold that changed the
 * length reports "no match"; both callers then take the passage from the front,
 * which is always in range.
 */
function firstMatchIndex(text, question) {
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return -1;
  let at = -1;
  for (const term of searchTerms(question)) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  return at;
}

/**
 * Drop a half-character left at either end of a slice.
 *
 * Both slicers below cut by UTF-16 code unit, so a boundary landing inside a
 * surrogate pair — any emoji or CJK extension in a lore note — leaves a lone
 * surrogate behind. On the way to the model it degrades to U+FFFD at UTF-8
 * encoding; on the way to the chat log it reaches `escapeHtml` and renders as a
 * replacement glyph in the middle of the quoted passage.
 *
 * Written with `charCodeAt` rather than a regex so the surrogate ranges are not
 * themselves spelled as escapes in this file.
 */
function trimSurrogates(text) {
  let out = String(text ?? "");
  const first = out.charCodeAt(0);
  if (first >= 0xDC00 && first <= 0xDFFF) out = out.slice(1);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) out = out.slice(0, -1);
  return out;
}

/**
 * A page name safe to put in the prompt's own structural header.
 *
 * The header is `[SOURCE: <name>]`, and the name is a document title — which a
 * player authors wherever Foundry grants `JOURNAL_CREATE`, which it does at
 * Trusted and above. A title containing a bracket or a newline can CLOSE that
 * header and open a forged one, which is a pseudo-system turn written by
 * whoever named the page. Brackets and line breaks out, whitespace collapsed,
 * length bounded.
 *
 * The same label is used for the search card's markers and for `sourceMap`, so
 * what the model can cite is exactly what resolves to a link.
 */
function sourceLabel(name) {
  const clean = String(name ?? "").replace(/[\r\n[\]]/g, " ").replace(/\s+/g, " ").trim();
  return clean.slice(0, 120) || "(untitled)";
}

/** A short piece of the document around the first match, for the search card. */
function excerptFor(doc, question) {
  const at = firstMatchIndex(doc.text, question);
  const start = Math.max(0, (at < 0 ? 0 : at) - 60);
  const slice = trimSurrogates(doc.text.slice(start, start + 240)).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${start + 240 < doc.text.length ? "…" : ""}`;
}

/**
 * Answer by finding, not by generating.
 *
 * Costs nothing, sends nothing anywhere, and needs no credential — which is
 * what makes it the default. Returns the same shape as everything else so the
 * card renders identically.
 */
/**
 * Citation name to the thing it names.
 *
 * Built from the documents that actually went into THIS answer, never from the
 * whole corpus: a citation the model invented for a document it was not given
 * must not resolve to a real page, or an invention becomes indistinguishable
 * from a source at exactly the moment the reader is checking.
 */
function sourceMap(docs) {
  const map = {};
  // Keyed on the LABEL, not the raw name: the model can only cite what it was
  // shown, and what it was shown went through `sourceLabel`. Sanitising one
  // side and not the other would make every citation render as unverified.
  for (const doc of docs) if (doc?.name && doc?.uuid) map[sourceLabel(doc.name)] = doc.uuid;
  return map;
}

function searchAnswer(question, docs, extra = {}) {
  const ranked = rankLore(question, docs).slice(0, LITE_SEARCH_RESULTS);
  if (ranked.length === 0) {
    return {
      content: [{ type: "text", text: t("lite.noMatches") }],
      _meta: { [MODULE_ID]: { loreGapRecorded: true, source: "lite-search", upsell: true, ...extra } },
    };
  }
  const lines = [t("lite.searchHeader", { count: ranked.length })];
  // Same label rule as the prompt: a page called "speculation" must not render
  // as the speculation chip, and a bracket in a page name must not forge a
  // marker that `citations()` then parses.
  for (const doc of ranked) lines.push(`- ${excerptFor(doc, question)} [${sourceLabel(doc.name)}]`);
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    _meta: {
      [MODULE_ID]: {
        source: "lite-search",
        upsell: true,
        sources: sourceMap(ranked),
        narrowed: ranked.some(doc => doc.shared === false),
        ...extra,
      },
    },
  };
}

// ─── Which models lite is allowed to use ─────────────────────────────────────
//
// A POLICY, not a list. A hardcoded set of model names is the same mistake as
// a hardcoded default, one size larger: Google retires and adds models on its
// own schedule, so any list written today is wrong by some later date, and the
// module cannot tell that it is wrong. A predicate can be evaluated against
// whatever the API actually offers, so the set stays correct without a release.
//
// The rule: Gemini **flash** and **flash-lite**, major version 3 or above.
// Flash is the quality end and flash-lite the cheap end, which is the whole
// range a free-tier front door needs; everything heavier is Vault's business.
// Pinning the floor at 3 rather than naming versions means a 4-series model
// is picked up the day it appears.

/** `gemini-3-flash`, `gemini-3.6-flash`, `gemini-4-flash-lite` — and nothing
 *  that is not a flash model. Preview and dated suffixes are deliberately
 *  excluded: a front door should not silently move onto a preview. */
const LITE_MODEL_PATTERN = /^gemini-(\d+)(?:\.(\d+))?-flash(-lite)?$/;
const LITE_MODEL_MIN_MAJOR = 3;

/** The parts of an allowed model name, or null when the policy excludes it. */
function parseModelName(name) {
  const match = LITE_MODEL_PATTERN.exec(String(name ?? "").trim());
  if (!match) return null;
  const major = Number(match[1]);
  if (!Number.isFinite(major) || major < LITE_MODEL_MIN_MAJOR) return null;
  return { name: String(name).trim(), major, minor: Number(match[2] ?? 0), lite: !!match[3] };
}

function isAllowedModel(name) {
  return parseModelName(name) !== null;
}

/**
 * Allowed models, best first.
 *
 * Newest major wins, then newest minor, then flash ahead of flash-lite —
 * quality before economy, because somebody trying the tool for the first time
 * is judging whether the answers are any good, not what they cost.
 */
function rankModels(names) {
  return (names ?? [])
    .map(parseModelName)
    .filter(Boolean)
    .sort((a, b) => b.major - a.major || b.minor - a.minor || Number(a.lite) - Number(b.lite));
}

/**
 * `fetchJson` for Google, with the browser's own failure prose translated.
 *
 * `VaultBridge.rpc` goes to real trouble to turn a fetch rejection into a
 * sentence a GM can act on, distinguishing an abort from an unreachable host.
 * The lite path had no equivalent, so a GM whose wifi dropped mid-session read
 * "Failed to fetch" (Chrome) or "NetworkError when attempting to fetch
 * resource" (Firefox) on the card and went to check a Foundry connection that
 * was visibly working — they were reading the message it had just delivered.
 * A two-minute hang surfaced as "The operation was aborted", which names
 * nothing at all.
 *
 * Its own codes, so the two are distinguishable in a diagnostics dump.
 */
async function geminiFetch(url, options, timeoutMs) {
  try {
    return await fetchJson(url, options, timeoutMs);
  } catch (err) {
    // Anything already translated passes through; only the raw rejection from
    // `fetch` itself needs this.
    if (err instanceof BridgeError) throw err;
    const timedOut = err?.name === "AbortError";
    throw new BridgeError(
      0,
      timedOut ? t("lite.timedOut") : t("lite.offline"),
      timedOut ? "TV-LITE-TIMEOUT" : "TV-LITE-OFFLINE"
    );
  }
}

/** Every model this key can reach, unfiltered. Names only. */
async function fetchGeminiModels(key) {
  const res = await geminiFetch(LITE_ENDPOINT, { headers: { "x-goog-api-key": key } }, 20_000);
  if (!res.ok) {
    throw new BridgeError(
      res.status,
      res.body?.error?.message ?? `Gemini answered ${res.status}.`,
      `TV-LITE-MODELS-${res.status || "ERR"}`
    );
  }
  return (res.body?.models ?? [])
    .filter(m => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map(m => String(m.name ?? "").replace(/^models\//, ""));
}

/** The best model this key can actually reach today, or null if the account
 *  has none the policy allows. */
async function bestAvailableModel(key) {
  const ranked = rankModels(await fetchGeminiModels(key));
  return ranked[0]?.name ?? null;
}

/** Does this failure mean "that model is gone", as opposed to anything else?
 *  Google answers 404 and says so; the sentence is matched too, because a 404
 *  on its own is also what a typo produces and both want the same recovery. */
function isRetiredModelError(status, message) {
  const text = String(message ?? "").toLowerCase();
  return status === 404 || text.includes("no longer available") || text.includes("is not found");
}

// ─── Layer 2: answers ────────────────────────────────────────────────────────

/** Below this, a slice of a document is too small to be worth the confusion of
 *  half-quoting it, and the document is honestly reported as dropped instead. */
const LITE_MIN_TRUNCATED_CHARS = 2000;

/**
 * The part of a document worth keeping when the whole of it will not fit.
 *
 * Centred on the earliest search term rather than taken from the front. A long
 * lore document is usually chronological — a session log, a family history — so
 * its first characters are its least relevant, and slicing from the start
 * reliably keeps the one part of it nobody asked about.
 *
 * A quarter of the window sits before the match so the passage has its lead-in;
 * the rest follows it.
 */
function windowAround(doc, question, room) {
  if (doc.text.length <= room) return doc.text;
  const at = firstMatchIndex(doc.text, question);
  if (at < 0) return trimSurrogates(doc.text.slice(0, room));

  // The lead-in marker is PAID FOR out of `room`, not added on top of it. The
  // caller sized `room` against what is left of the prompt budget, so returning
  // `room + 2` characters quietly overspends the cap it was asked to respect.
  const lead = "… ";
  const body = room - lead.length;
  const start = Math.max(0, Math.min(at - Math.floor(body / 4), doc.text.length - body));
  if (start === 0) return trimSurrogates(doc.text.slice(0, room));
  return `${lead}${trimSurrogates(doc.text.slice(start, start + body))}`;
}

/** As much of the corpus as fits, best matches first, each labelled so the
 *  model can cite it by name. */
function buildPrompt(question, docs) {
  const ranked = rankLore(question, docs);
  const ordered = ranked.length > 0 ? ranked : docs;
  const parts = [];
  const used = [];
  let budget = LITE_CORPUS_CHAR_CAP;
  let dropped = 0;
  let truncated = false;

  // First pass: everything that fits WHOLE, best first. Whole documents are
  // strictly better than fragments, so they get first refusal on the budget
  // regardless of how the leftovers are then handled.
  const tooLarge = [];
  for (const doc of ordered) {
    // SANITISED, not interpolated raw. The name is a document title, and a
    // title is authored by whoever can create a journal — Trusted and above in
    // Foundry's defaults. A bracket or a newline in one closes this header and
    // opens a forged one: a pseudo-system turn written by whoever named the
    // page. `sourceMap` keys on the same label, so what the model is able to
    // cite stays exactly what resolves to a link.
    const block = `[SOURCE: ${sourceLabel(doc.name)}]\n${doc.text}\n`;
    if (block.length <= budget) {
      parts.push(block);
      used.push(doc);
      budget -= block.length;
    } else {
      tooLarge.push(doc);
    }
  }

  // Second pass: the best document that did not fit gets whatever is left.
  //
  // Until 1.1.0 there was no second pass — a document larger than the remaining
  // budget was skipped, silently and entirely. A GM whose answer lived in one
  // long session log got "I am unsure about this detail" while the passage sat
  // in the document that had been thrown away, and `included`/`total` was
  // computed and then read by nothing.
  //
  // Doing this AFTER the whole-document pass matters: spending the budget on a
  // fragment first would evict several complete notes to make room for part of
  // one. The window is taken around the match rather than from the front,
  // because a long lore document is usually chronological and its opening is
  // its least relevant part.
  if (tooLarge.length > 0) {
    const [best, ...rest] = tooLarge;
    const header = `[SOURCE: ${sourceLabel(best.name)}]\n`;
    const room = budget - header.length - TRUNCATION_MARKER.length - 1;
    if (room >= LITE_MIN_TRUNCATED_CHARS) {
      parts.push(`${header}${windowAround(best, question, room)}${TRUNCATION_MARKER}\n`);
      used.push(best);
      truncated = true;
      dropped = rest.length;
    } else {
      dropped = tooLarge.length;
    }
  }

  return {
    used,
    included: used.length,
    // `considered` IS WHAT `included` IS A FRACTION OF: the documents that
    // matched the question at all. `total` is the whole folder, a different
    // number — and it was the one being reported, so a hundred-page folder with
    // three matches said "Read 3 of 100 notes, the rest did not fit", blaming
    // the size cap for ninety-seven notes that were simply about something
    // else. A GM reading that concludes their folder is too big to use and
    // starts deleting notes to fix a problem they do not have.
    considered: ordered.length,
    total: docs.length,
    dropped,
    truncated,
    text: `${parts.join("\n")}\n---\nQuestion: ${question}`,
  };
}

/**
 * Ask Gemini, from the GM's browser, with the GM's key.
 *
 * The key goes in the `x-goog-api-key` HEADER rather than the query string
 * Gemini also accepts. A key in a URL is a key in every access log, proxy log
 * and browser history entry between here and Google; a key in a header is not.
 */
async function askGemini(question, docs, { key, model }) {
  const prompt = buildPrompt(question, docs);

  // A model outside the policy is a WARNING, never a refusal. The policy
  // governs what the module picks for itself; a GM must always be able to
  // type whatever Google ships next, or a naming change nobody predicted
  // turns this into a dead end until a release goes out.
  if (!isAllowedModel(model)) {
    record("warn", "TV-LITE-MODEL-ODD", `configured model "${model}" is outside the flash/flash-lite policy`);
  }

  let res = await requestGemini(prompt, key, model);

  // Self-healing, once. Google retires models on its own schedule, so this
  // failure is expected eventually rather than exceptional — and a GM should
  // not have to read an error, find a setting and guess a name to get their
  // table working again mid-session.
  if (!res.ok && isRetiredModelError(res.status, res.body?.error?.message)) {
    const replacement = await recoverModel(key, model);
    if (replacement) res = await requestGemini(prompt, key, replacement);
  }

  if (!res.ok) {
    // Google's own sentence, verbatim — it names an expired key, a disabled
    // API and an unknown model differently, and each has a different fix.
    const detail = res.body?.error?.message ?? `Gemini answered ${res.status}.`;
    throw new BridgeError(res.status, detail, `TV-LITE-${res.status || "ERR"}`);
  }

  const text = (res.body?.candidates?.[0]?.content?.parts ?? [])
    .map(part => part.text ?? "")
    .join("")
    .trim();

  if (!text) {
    // A blocked or empty candidate is not a transport failure, and saying "the
    // archive is unreachable" would send the GM to look at their network.
    const reason = res.body?.candidates?.[0]?.finishReason ?? res.body?.promptFeedback?.blockReason;
    throw new BridgeError(200, t("lite.noAnswer", { reason: reason ?? "empty" }), "TV-LITE-EMPTY");
  }

  if (prompt.dropped > 0 || prompt.truncated) {
    record("warn", "TV-LITE-CORPUS-CAPPED", "the corpus did not fit in one question", {
      included: prompt.included,
      considered: prompt.considered,
      total: prompt.total,
      dropped: prompt.dropped,
      truncated: prompt.truncated,
    });
  }

  return {
    content: [{ type: "text", text }],
    _meta: {
      [MODULE_ID]: {
        source: "lite-gemini",
        upsell: true,
        loreGapRecorded: text.toLowerCase().includes(LITE_LORE_GAP_FRAGMENT),
        // Only the documents that actually reached the model. A citation for
        // anything else is the model's invention and must not be linkable.
        sources: sourceMap(prompt.used),
        narrowed: prompt.used.some(doc => doc.shared === false),
        corpus: {
          included: prompt.included,
          considered: prompt.considered,
          total: prompt.total,
          dropped: prompt.dropped,
          truncated: prompt.truncated,
        },
      },
    },
  };
}

/**
 * One request. The key goes in the `x-goog-api-key` HEADER rather than the
 * query string Gemini also accepts — a key in a URL is a key in every access
 * log, proxy log and browser history entry between here and Google.
 */
function requestGemini(prompt, key, model) {
  return geminiFetch(
    `${LITE_ENDPOINT}/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: LITE_SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: prompt.text }] }],
        safetySettings: buildSafetySettings(setting("liteFilters") === true),
      }),
    },
    LITE_TIMEOUT_MS
  );
}

/**
 * Find a model that still exists, remember it, and say so.
 *
 * Writing the setting is the point: without it every question afterwards pays
 * for the same discovery, and the GM's panel keeps showing a name that does
 * not work. Only a GM may write a world setting — the relay always is one, and
 * the guard is there for the case where that stops being true.
 *
 * Returns null when nothing better is available, and the caller then reports
 * the ORIGINAL failure. A recovery that cannot recover must not replace a
 * precise error with a vaguer one.
 */
async function recoverModel(key, current) {
  let best = null;
  try {
    best = await bestAvailableModel(key);
  } catch (err) {
    warn("could not list models while recovering", err);
    return null;
  }
  if (!best || best === current) return null;

  record("warn", "TV-LITE-MODEL-MOVED", `"${current}" is gone; using "${best}"`);
  let saved = false;
  if (game.user?.isGM) {
    try {
      await setSetting("liteModel", best);
      saved = true;
    } catch (err) {
      warn("could not save the replacement model", err);
    }
  }

  // TELL THE GM WHAT ACTUALLY HAPPENED, and tell nobody else. This used to
  // announce "the model was changed" unconditionally — including when the write
  // had just failed, and on a client that is not a GM and therefore never
  // wrote at all. A GM who reads that and finds the setting unchanged next
  // session has been told something untrue by the thing reporting the repair.
  if (game.user?.isGM) {
    ui.notifications?.info?.(t(saved ? "notify.modelMoved" : "notify.modelMovedOnce", { from: current, to: best }));
  }
  return best;
}

// ─── The seam ────────────────────────────────────────────────────────────────

/**
 * Answer without Vault.
 *
 * Runs on the elected GM's client only, which is what keeps the key off every
 * other machine at the table: a player's browser never holds it and never
 * makes the call. That is the bridge's own relay election, reused unchanged.
 */
async function answerLocally(question, asker) {
  if (!game.user.isGM) throw new BridgeError(403, t("lite.gmOnly"), "TV-LITE-NOTGM");

  const docs = collectLore(asker);
  if (docs.length === 0) {
    throw new BridgeError(
      404,
      t("lite.noFolder", { folder: setting("liteFolder") || LITE_DEFAULT_FOLDER, site: DOCS_SITE }),
      "TV-LITE-NOCORPUS"
    );
  }

  const key = (setting("geminiKey") || "").trim();
  const answersOn = setting("liteAnswers") === true;

  // Layer 1 is the default and the fallback. Reaching layer 2 needs BOTH the
  // table to have turned answers on and this browser to hold a key — the two
  // are separate settings on purpose, because one is a table policy and the
  // other is a credential that must never leave this machine.
  if (!answersOn) return searchAnswer(question, docs);

  // Answers ARE on, and this browser has no key. Silently searching instead is
  // the wrong thing: the setting is world-scoped so it is on for everybody,
  // the key is per browser, and the client that answers is whichever GM
  // `activeGM` elects. A GM who set a key on their laptop and is relaying from
  // a different machine — or a second GM who never set one — gets search
  // results with no hint why. Say so, to the one person who can fix it, once.
  if (!key) {
    if (!warnedLiteKeyMissing) {
      warnedLiteKeyMissing = true;
      record("warn", "TV-LITE-NOKEY-HERE", "answers are on, but this client holds no key");
      ui.notifications?.warn?.(t("notify.liteKeyMissingHere"));
    }
    return searchAnswer(question, docs, { keyMissing: true });
  }

  // A key is present, so re-arm: if it disappears later the GM is told again.
  warnedLiteKeyMissing = false;
  record("info", "TV-LITE-ASK", "answering locally", { docs: docs.length });
  return askGemini(question, docs, { key, model: (setting("liteModel") || LITE_MODEL_DEFAULT).trim() });
}

/** Which half of the module answers. The bridge is the default: this module is
 *  the bridge to Tusk's Vault first, and a cut-down archivist second. */
function usingLite() {
  return setting("answerSource") === "lite";
}

// ─── Chat: the asker's side ──────────────────────────────────────────────────

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Chosen so it cannot appear in escaped model output: renderAnswer's stripping pass
 *  removes every character in this range before the text gets here. */
const FENCE_SENTINEL = "\u0001";

/**
 * Render an answer for the chat log.
 *
 * THE INVARIANT, which nothing below may break: the text is escaped ONCE, at
 * the top, and every function after that operates on already-escaped text and
 * only ever ADDS tags of our own. The answer is model output assembled from the
 * GM's documents and it lands in a log every player renders — treating it as
 * HTML would make any stray markup in a lore note into script running on every
 * client at the table.
 *
 * Two consequences that are easy to forget when editing the patterns:
 *
 *   - A blockquote marker arrives as `&gt;`, not `>`.
 *   - Vault's rules-fallback citation arrives as `[D&amp;D 5e]`, not `[D&D 5e]`.
 *
 * Both are matched in their escaped form below. Matching the raw form silently
 * matches nothing, which presents as a formatting feature that simply never
 * works.
 */
function renderAnswer(text, sources = {}) {
  // Control characters are stripped before anything else so the fenced-code
  // placeholders below cannot be forged by a model emitting one.
  const safe = escapeHtml(String(text ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ""));

  // FOUNDRY ENRICHES CHAT CONTENT, and enricher syntax carries no HTML
  // metacharacters — so `@UUID[...]`, `@Embed[...]` and `[[/r 1d20]]` pass
  // through `escapeHtml` byte for byte. `citations()` eats most bracketed runs,
  // but its generic pattern caps at 60 characters and a page uuid is 63, so an
  // `@Embed[JournalEntry.<16>.JournalEntryPage.<16>]` the model was talked into
  // emitting survives intact into the chat log — where Foundry renders it as a
  // native link or an inline document, inside the card's own "this came from
  // your archive" styling. That is UI spoofing at minimum, and the model's
  // output is the least trusted text on the page.
  //
  // The text is already HTML-escaped at this point, so inserting an entity is
  // safe: it renders as the character and no longer parses as a marker.
  const inert = safe
    .replace(/@(?=[A-Za-z]+\[)/g, "&#64;")
    .replace(/\[\[/g, "[&#91;");

  const fences = [];
  const withoutFences = inert.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code) => {
    fences.push(`<pre><code>${code.replace(/\n+$/, "")}</code></pre>`);
    return `${FENCE_SENTINEL}${fences.length - 1}${FENCE_SENTINEL}`;
  });

  // The citation names reaching `citations()` have been through `escapeHtml`
  // along with the rest of the answer, so the lookup table has to be keyed the
  // same way or a journal called "Tusk's Lore" never matches "Tusk&#39;s Lore"
  // and every citation for it renders as unverified. Escaped once, here, rather
  // than per citation.
  const keyed = {};
  for (const [name, uuid] of Object.entries(sources ?? {})) keyed[escapeHtml(name)] = uuid;

  const html = renderBlocks(withoutFences, keyed);
  return html.replace(
    new RegExp(`${FENCE_SENTINEL}(\\d+)${FENCE_SENTINEL}`, "g"),
    (_m, i) => fences[Number(i)] ?? ""
  );
}

/**
 * Group lines into blocks.
 *
 * A hand-rolled line walker rather than a markdown library, for the same reason
 * the rest of this file is hand-rolled: a dependency here would have to be
 * bundled into the module, audited for what it does with untrusted input, and
 * kept in step with a security property that is currently one line at the top
 * of `renderAnswer`. The subset below is what Vault's answers actually contain.
 */
function renderBlocks(escaped, sources = {}) {
  const lines = escaped.split("\n");
  const out = [];
  let paragraph = [];
  let list = null; // { tag: "ul" | "ol", items: string[] }
  let quote = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(paragraph.join("<br>"), sources)}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map(item => `<li>${inline(item, sources)}</li>`).join("");
    out.push(`<${list.tag}>${items}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    out.push(`<blockquote>${inline(quote.join("<br>"), sources)}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) {
      flushAll();
      continue;
    }

    // A fenced block is already rendered; it stands alone.
    if (line.trim().startsWith(FENCE_SENTINEL)) {
      flushAll();
      out.push(line.trim());
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      // Every level renders at the same size. The chat sidebar is ~300px wide
      // and a model that opens with `#` is not asking for 2em type in it — the
      // useful information is that the line is a heading, not which depth.
      out.push(`<p class="tusks-vault-heading">${inline(heading[2], sources)}</p>`);
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(line.trim())) {
      flushAll();
      out.push('<hr class="tusks-vault-rule">');
      continue;
    }

    // `&gt;`, because the text has already been escaped.
    const blockquote = /^&gt;\s?(.*)$/.exec(line);
    if (blockquote) {
      flushParagraph();
      flushList();
      quote.push(blockquote[1]);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      flushQuote();
      if (list?.tag !== "ul") {
        flushList();
        list = { tag: "ul", items: [] };
      }
      list.items.push(bullet[1]);
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushParagraph();
      flushQuote();
      if (list?.tag !== "ol") {
        flushList();
        list = { tag: "ol", items: [] };
      }
      list.items.push(numbered[1]);
      continue;
    }

    // A plain line continuing a list is that item's second line, not a new
    // paragraph — models wrap long bullets.
    if (list) {
      list.items[list.items.length - 1] += `<br>${line.trim()}`;
      continue;
    }

    flushQuote();
    paragraph.push(line);
  }

  flushAll();
  return out.join("");
}

/** Inline spans, applied to one already-escaped block of text. */
function inline(escaped, sources = {}) {
  return citations(
    escaped
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>"),
    sources
  );
}

/**
 * Vault's citation markers, as chips.
 *
 * This is the whole reason the answer card is worth styling at all. Vault's
 * core rules require every factual claim to end with a marker naming where it
 * came from, so an answer is not prose with references bolted on — it is a
 * sequence of claims, each carrying its provenance. Rendering those as flat
 * bracketed text buries the single most useful thing on screen.
 *
 * The colours carry that meaning rather than decorating it: what the archive
 * holds, what the GM said, what is general rules knowledge, and what the model
 * has flagged as not fact at all are four different kinds of statement, and a
 * player skimming the log should be able to tell them apart without reading.
 *
 * ORDER MATTERS. The generic source pattern matches any short bracketed run, so
 * every specific marker has to be consumed before it. The chips are emitted
 * with a sentinel-free marker class and no attributes drawn from the match —
 * the captured text is already escaped, and it goes in as text content only.
 */
function citations(escaped, sources = {}) {
  return escaped
    .replace(
      /\[clarification:\s*([^\]\n]{1,80})\]/gi,
      (_m, id) => chip("clarification", `DM: ${id.trim()}`)
    )
    // `&amp;`, because the text has already been escaped.
    .replace(/\[D&amp;D 5e\]/gi, () => chip("rules", "D&amp;D 5e"))
    .replace(/\[speculation\]/gi, () => chip("speculation", "speculation"))
    .replace(/\[sanitised[^\]\n]{0,60}\]/gi, () => chip("sanitised", "sanitised"))
    // Anything else short and bracketed is a source filename. Capped in length
    // and barred from containing a tag we just inserted, so an ordinary
    // parenthetical aside in prose is not mistaken for a citation.
    .replace(/\[([^\]\n<>]{1,60})\]/g, (_m, name) => sourceChip(name.trim(), sources));
}

/**
 * A source citation — as a link when it names something real, as a flagged chip
 * when it does not.
 *
 * The link is the promise kept. Foundry binds one delegated click handler to
 * `a[data-link]` on the body, and `JournalEntryPage#_onClickDocumentLink`
 * opens the parent journal AT that page — so a citation carrying a PAGE uuid
 * lands the reader on the passage rather than at the top of a forty-page
 * entry. That only became possible when the corpus started being indexed per
 * page; before it, the only uuid available named the whole journal.
 *
 * The unverified case matters as much. A model can emit a citation for a
 * document it was never given, and until now that was indistinguishable on
 * screen from one it was. `sources` holds only what actually went into THIS
 * prompt, so anything absent from it is either an invention or a document the
 * asker could not read — both of which the reader deserves to see marked.
 *
 * The name is interpolated into an attribute, so it is escaped AGAIN here. It
 * arrives already escaped for text context, which is not the same thing: the
 * uuid is ours, but the name came out of a model.
 */
function sourceChip(name, sources) {
  const map = sources ?? {};
  // NO MAP MEANS NO CLAIM, not a failed check. A Vault answer arrives over the
  // bridge with real citations this module has no index for, and marking those
  // "unverified" would libel the half of the module that is doing the better
  // job. Absence of evidence is rendered exactly as it was before 1.1.0.
  if (Object.keys(map).length === 0) return chip("source", name);

  const uuid = Object.prototype.hasOwnProperty.call(map, name) ? map[name] : null;
  if (!uuid) return chip("unverified", name);
  return `<a class="content-link tusks-vault-cite is-source" data-link data-uuid="${escapeHtml(uuid)}">` +
    `<i class="fas fa-book-open"></i>${name}</a>`;
}

/**
 * Has this answer earned the line about the full application?
 *
 * It used to appear on every lite answer, which is an advertisement under
 * every answer forever — the single thing most likely to make a free tier read
 * as a trial rather than a finished product, and the reason tables uninstall
 * modules that are otherwise fine.
 *
 * The fix is not a quota but a reason. Each case below is a moment the table
 * has actually met a limit lite has and Vault does not, so the line stops being
 * a pitch and becomes the answer to the question they just asked:
 *
 *   - it could not find anything, and Vault matches meaning rather than words;
 *   - the corpus did not fit, and Vault indexes instead of stuffing a prompt;
 *   - written answers are on with no key here, and Vault keeps keys off browsers.
 *
 * An answer that worked says nothing. Somebody who wants the comparison has the
 * settings panel, the About screen and the package page; somebody who is happy
 * is left alone.
 */
function upsellEarned(meta) {
  return !!(
    meta.keyMissing ||
    meta.loreGapRecorded ||
    meta.corpus?.dropped > 0 ||
    meta.corpus?.truncated
  );
}

/**
 * The line pointing at the full application.
 *
 * Built HERE rather than inside the answer text, because it is the only markup
 * on the card the module writes itself. `renderAnswer` escapes everything it is
 * given — correctly, since that text came from a model — so a link placed in
 * there would arrive as visible angle brackets. Keeping the two apart lets this
 * be a real link without weakening the escaping rule by a single character.
 */
function upsellFooter(meta) {
  if (!meta?.upsell || !upsellEarned(meta)) return "";
  const line = meta.keyMissing ? t("lite.footerNoKey") : t("lite.footer");
  return `<p class="tusks-vault-upsell">${escapeHtml(line)} ` +
    `<a href="${DOCS_SITE}">${escapeHtml(t("lite.footerLink"))}</a> · ` +
    `<a href="${VAULT_REPO}">${escapeHtml(t("lite.footerRepo"))}</a></p>`;
}

/**
 * The two things about an answer that are the module's fault rather than the
 * archive's, said on the card rather than only in a log.
 *
 * The corpus note exists because the failure it describes is invisible and
 * looks exactly like the archive not knowing. Until 1.1.0 the cap was enforced
 * silently: a document too large to fit was dropped, `included`/`total` was
 * computed and then read by nothing, and a GM whose answer lived in the one
 * dropped note got "I am unsure about this detail" with no way to find out why.
 */
function corpusNote(meta, narrowedForId) {
  const notes = [];
  const corpus = meta?.corpus;
  // TWO DIFFERENT FAILURES, TOLD APART. "Some of what matched was never read"
  // and "one long note was read in part" have different remedies — split the
  // folder up, versus nothing, the answer is fine — and saying both with one
  // sentence about not fitting told a GM to fix the wrong one.
  if (corpus && corpus.dropped > 0) {
    notes.push(t("lite.corpusDropped", {
      included: corpus.included,
      // A bridge answer's corpus block comes from Vault, which does not send
      // `considered`. Falling back to `total` keeps the old wording for it.
      considered: corpus.considered ?? corpus.total,
    }));
  }
  if (corpus && corpus.truncated) notes.push(t("lite.corpusTruncated"));
  if (narrowedForId) notes.push(t("chat.answeredPrivately"));
  return notes.map(note => `<p class="notes tusks-vault-note">${escapeHtml(note)}</p>`).join("");
}

function chip(kind, label) {
  return `<span class="tusks-vault-cite is-${kind}">${label}</span>`;
}

/**
 * The entities Foundry's serializer can put in a chat message, and nothing else.
 *
 * This set is closed, not a guess: v14 escapes text nodes with `escapeHTML`,
 * which its own documentation states handles only `&`, `<`, `>`, `"` and `'`.
 * `&#39;` is carried too — the same apostrophe, written the other legal way, in
 * case anything between the editor and this hook re-escapes.
 */
const HTML_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
};

/**
 * Reduce what Foundry hands the hook to the text the user actually typed.
 *
 * v14's chat bar is a ProseMirror editor, so `chatMessage` fires with the
 * SERIALIZED HTML of the editor document — `<p>/tusk who runs the harbour?</p>`
 * — and not the typed string. Foundry strips that wrapper itself, but inside
 * `ChatLog.parse`, which runs AFTER this hook. So a trigger matched against the
 * raw argument never fires; Foundry then strips the wrapper, fails to recognise
 * the command, and reports "/tusk is not a valid chat message command" — the
 * module looking absent while being loaded, registered and enabled.
 *
 * v13, this module's declared minimum, still uses a plain textarea and passes
 * plain text. Text with no tags and no entities falls through here unchanged,
 * so one path serves both.
 *
 * String work rather than a DOM round-trip, so the same code the GM runs is the
 * code the (deliberately node-only) test suite covers. Entities are decoded in
 * a single pass AFTER tags are stripped: two passes would turn a typed
 * `&amp;lt;` into `<`, and decoding first would turn a typed `&lt;p&gt;` into
 * markup that the tag strip then ate.
 */
function plainText(raw) {
  return String(raw ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#x27|#39);/gi, m => HTML_ENTITIES[m.toLowerCase()] ?? m)
    .trim();
}

/** Does this chat input invoke the archivist? Returns the question, or null. */
function parseTrigger(raw) {
  const text = plainText(raw);
  if (!text) return null;

  const command = (setting("triggerCommand") || "tusk").trim();
  const botName = (setting("botName") || "Tusk").trim();

  if (command) {
    const bare = new RegExp(`^/${escapeRegExp(command)}$`, "i");
    if (bare.test(text)) return { question: "" };
    const withArg = new RegExp(`^/${escapeRegExp(command)}\\s+([\\s\\S]+)$`, "i");
    const match = withArg.exec(text);
    if (match) return { question: match[1].trim() };
  }

  if (botName) {
    // Foundry has no bot user and no native user-mention syntax, so the mention
    // form is a plain content match. That is all it needs to be.
    const mention = new RegExp(`^@${escapeRegExp(botName)}\\b[\\s,:]*([\\s\\S]*)$`, "i");
    const match = mention.exec(text);
    if (match) return { question: match[1].trim() };
  }

  return null;
}

/**
 * Say what actually went wrong in the chat trigger.
 *
 * Foundry catches whatever a hook throws, logs it, and returns `undefined` —
 * which is not `false`, so `processMessage` carries on, fails to recognise the
 * command, and tells the table `/tusk` is not a valid command. That is the one
 * explanation guaranteed to be wrong, and it sends the GM hunting for a module
 * that is installed, enabled and running. Foundry raises no notification of its
 * own here (`Hooks.onError` is called with `notify: null`), so unless the
 * console happens to be open the real fault is invisible.
 */
function reportTriggerFailure(err) {
  record("error", "TV-TRIGGER-FAIL", err?.message ?? String(err));
  console.error(`${MODULE_ID} | chat trigger failed:`, err);
  ui.notifications?.error?.(t("notify.triggerFailed", { detail: err?.message ?? String(err) }));
}

const onChatMessage = (_chatLog, message) => {
  // Deciding whether the message is even ours gets its own try, and declines on
  // failure. At this point it is far more likely to be someone's ordinary chat
  // than a question for the archivist, and swallowing the table's chat would be
  // a much worse failure than the one being handled.
  let parsed = null;
  try {
    if (!setting("enabled")) return;
    parsed = parseTrigger(message);
  } catch (err) {
    reportTriggerFailure(err);
    return;
  }
  if (!parsed) return;

  // Past here the message IS ours, so every exit swallows it — including the
  // failing one. Handing a half-processed command back would post the raw
  // `/tusk …` text to the table on top of whatever already went wrong.
  try {
    if (!parsed.question) {
      ui.notifications.info(t("notify.askSomething", { command: setting("triggerCommand") || "tusk" }));
      return false;
    }

    // Post the question as a real document so the table sees it asked, carrying a
    // flag for the GM's client to notice. Returning false halts Foundry's own
    // handling of the raw input — otherwise the command text would also appear.
    //
    // Not awaited: the hook is synchronous, and Foundry inspects the returned
    // value rather than a promise. That makes the rejection path ours to catch
    // by hand, or a failed create is an unhandled rejection and the asker is
    // left watching a command that did nothing.
    ChatMessage.create({
      content: escapeHtml(parsed.question),
      flags: { [MODULE_ID]: { query: parsed.question } },
    }).catch(reportTriggerFailure);
    return false;
  } catch (err) {
    reportTriggerFailure(err);
    return false;
  }
};

// A MARKER THE DIAGNOSTICS CAN SEE without reading this function back as
// source. `selfTest` reports whether the trigger hook is registered, and it
// used to answer by searching the function text for a name a minifier is
// free to rewrite.
onChatMessage.tusksVaultTrigger = true;
Hooks.on("chatMessage", onChatMessage);

// ─── Chat: the GM's side ─────────────────────────────────────────────────────

// ─── What a question is allowed to cost ──────────────────────────────────────
//
// THE RELAY SPENDS THE GM'S MONEY ON A PLAYER'S SAY-SO. That is the arrangement
// lite mode is: a player types `/tusk …`, the active GM's browser assembles up
// to `LITE_CORPUS_CHAR_CAP` of lore and calls Gemini with the GM's own key. It
// is the right design — the key never leaves the one browser that holds it —
// but until 1.1.1 nothing on that path was bounded, so "a player at your table
// can spend your key" was true, unlimited and undocumented.
//
// BOUNDED BY CONCURRENCY, NOT BY A CLOCK. A rate limit per minute is the
// obvious shape and it is the wrong one here: any window generous enough never
// to interrupt a real table is also generous enough to be worth abusing, and a
// window tight enough to matter eventually refuses a GM who is simply testing
// their own notes. Nobody can meaningfully ask a second question before the
// first one comes back, so ONE IN THE AIR PER PERSON costs a real table
// nothing and bounds a script completely: five hundred messages arriving in one
// tick claim the slot once and are refused four hundred and ninety-nine times.
// What remains is bounded by Google's own latency rather than by typing speed.
//
// THE CLAIM IS MADE BEFORE THE FIRST `await`, which is what makes that true.
// JavaScript runs each hook invocation's synchronous prefix to completion, so
// the burst is refused without any of it reaching a `fetch`.
//
// Deliberately NOT a spend cap in currency: this module cannot see prices, and
// a limit it cannot enforce honestly is worse than none. Google's own budget
// cap remains the backstop, and SECURITY.md says so.
const ASK_QUESTION_MAX_CHARS = 2_000;
const ASK_MAX_IN_FLIGHT = 4;

/** Who has a question in the air right now. */
const asking = new Set();

/** `null` when the question may proceed — and it CLAIMS the slot in the same
 *  synchronous step, which is the whole point. Any other value is the code
 *  naming which limit was met. Every path that claims must `releaseAskSlot`. */
function claimAskSlot(userId) {
  if (asking.has(userId)) return "TV-ASK-BUSY";
  if (asking.size >= ASK_MAX_IN_FLIGHT) return "TV-ASK-QUEUE";
  asking.add(userId);
  return null;
}

function releaseAskSlot(userId) {
  asking.delete(userId);
}

Hooks.on("createChatMessage", (message) => {
  // THE HOOK ITSELF MUST NOT THROW. Foundry does not await a hook's return, so
  // a rejection here is an unhandled promise rejection: nothing posted, nothing
  // recorded, and the asker's question left in the log with no answer and no
  // error card — the exact "this module is broken" outcome the rest of this
  // file works to avoid. The trigger that actually happens is another module
  // vetoing message creation from `preCreateChatMessage`, which makes
  // `ChatMessage.create` resolve to `undefined` and every `update` below a
  // TypeError thrown from inside the handler meant to report it.
  //
  // The (already-settled) promise is still RETURNED. Foundry ignores it, and
  // returning it is what lets this be tested at all — a caller that cannot wait
  // for the answer can only assert on the placeholder.
  return relayQuestion(message).catch(err => {
    warn("the archivist hook failed", err);
    record("error", "TV-ASK-HOOK-FAILED", "a question was lost before any answer could be posted", {
      cause: err?.code ?? err?.name ?? "(unknown)",
    });
    // Belt and braces. Every path inside releases its own slot; if one ever
    // stops doing so, the cost is that person never being answered again this
    // session, which is too quiet a failure to leave to care alone.
    releaseAskSlot(message?.author?.id);
  });
});

async function relayQuestion(message) {
  const raw = message.flags?.[MODULE_ID]?.query;
  if (!raw) return;
  // A QUESTION IS BOUNDED. The flag is written by whoever authored the message,
  // and nothing between there and the prompt limited its size — so a two
  // hundred kilobyte "question" was two hundred kilobytes of billed tokens on
  // the GM's key, every time it was asked.
  const query = String(raw).slice(0, ASK_QUESTION_MAX_CHARS);
  if (!setting("enabled")) return;

  // `author` is Foundry's own attribution, set server-side. Never trust
  // anything in the message payload for identity — a player can set arbitrary
  // flags on a message they create, so a flag claiming `isGM: true` proves
  // nothing.
  const author = message.author;
  if (!author) return;

  const activeGM = game.users.activeGM;

  if (!activeGM) {
    // Exactly one client should say this, and it should be the person who
    // asked — otherwise every connected client posts the same warning.
    if (author.id === game.user.id) ui.notifications.warn(t("notify.noActiveGM"));
    return;
  }

  // The election. Only the active GM relays; every other client returns here.
  if (game.user.id !== activeGM.id) return;

  const askPolicy = setting("askPolicy") || "everyone";
  const visibility = setting("replyVisibility") || "asker";
  const speaker = { alias: (setting("botName") || "Tusk").trim() };

  if (!mayAsk(askPolicy, allowedUserIds(), author)) {
    // Recorded, because "why was my player refused?" is otherwise unanswerable
    // from the outside: the rank and the list both have to line up, and neither
    // is visible in the chat message. The asker's ROLE, never their name or id.
    record("info", "TV-ASK-REFUSED", `asker below policy "${askPolicy}"`, {
      askerRole: author.role ?? "(unknown)",
      allowListSize: allowedUserIds().length,
    });
    // Whispered to the asker and the relay, not posted to the table. A refusal
    // read aloud to everyone is a small public telling-off for typing a command
    // the module itself offered to them.
    await ChatMessage.create({
      content: t("chat.notPermitted"),
      speaker,
      whisper: [author.id, game.user.id],
    });
    return;
  }

  // THE SPEND BUDGET, before anything that costs. Deliberately placed after
  // the policy check — someone who may not ask at all should be told that, not
  // told to slow down — and before the first `await`, which is what makes it
  // hold against a burst.
  const overBudget = claimAskSlot(author.id);
  if (overBudget) {
    record("info", "TV-ASK-BUDGET", "a question was refused by the relay's own budget", {
      code: overBudget,
      askerRole: author.role ?? "(unknown)",
    });
    // Whispered to the asker and the relay, like the policy refusal: this is
    // not the table's business, and the asker is the one who needs to know the
    // question did not land.
    await ChatMessage.create({
      content: overBudget === "TV-ASK-BUSY" ? t("chat.askBusy") : t("chat.askQueue"),
      speaker,
      whisper: [author.id, game.user.id],
    });
    return;
  }

  // Lite answers from this client and needs no pairing, so the whole bridge
  // resolution — discovery, token, session — is skipped rather than failed.
  const lite = usingLite();
  const activeBridge = lite ? null : await resolveBridge();
  if (!lite && !activeBridge) {
    // The GM gets the instruction, because only a GM can act on it. But the
    // ASKER has to be told something too: their question is sitting in the log
    // looking asked, and in silence they will simply ask it again. Two
    // messages, because the setup steps are noise to a player who cannot
    // perform them.
    await ChatMessage.create({
      content: t("chat.notConnected"),
      speaker,
      whisper: [game.user.id],
    });
    if (author.id !== game.user.id) {
      await ChatMessage.create({
        content: t("chat.notConnectedAsker"),
        speaker,
        whisper: [author.id],
      });
    }
    record("warn", "TV-ASK-UNPAIRED", "relayed a question with no usable bridge", {
      relayIsAsker: author.id === game.user.id,
    });
    releaseAskSlot(author.id);
    return;
  }

  const whisper = whisperTargets(visibility, author.id);

  // In `gm` visibility the asker is not in that audience, so from their seat
  // the question goes into the log and nothing ever comes back — which is what
  // a broken module looks like. One line telling them where the answer went is
  // the whole difference.
  if (whisper.length > 0 && !whisper.includes(author.id)) {
    try {
      await ChatMessage.create({
        content: t("chat.answeredToGM"),
        speaker,
        whisper: [author.id],
      });
    } catch (err) {
      // A COURTESY NOTE MUST NOT ABORT THE ANSWER. Unguarded, a throw here
      // escaped before the try below and left the asker's slot claimed with
      // nothing to release it, so that person could never ask again this
      // session — a worse outcome than the note they did not get.
      warn("could not tell the asker where the answer went", err);
    }
  }

  // A placeholder goes up immediately. An answer can take 5-10 seconds on a
  // subscription provider and longer behind a queue; silence for that long
  // reads as broken.
  //
  // THREE WAYS IT CAN FAIL, and the try covers all of them: a synchronous throw
  // from another module's `preCreateChatMessage` veto, a rejected promise, and
  // a resolved `undefined`. `await` alone handles none of them — it re-throws
  // the first two out of a handler nothing is awaiting.
  let placeholder = null;
  try {
    placeholder = await ChatMessage.create({
      content: `<em class="tusks-vault-thinking">${t("chat.thinking")}</em>`,
      speaker,
      whisper,
    });
  } catch (err) {
    warn("the placeholder could not be posted", err);
  }

  // NO PLACEHOLDER MEANS NO ANSWER TO UPDATE. Another module vetoing creation
  // from `preCreateChatMessage` makes this `undefined`, and every `update`
  // below then threw a TypeError — including the one inside the catch block,
  // which turned a handled failure into a lost one. Say so once, to the person
  // who can act on it, and stop.
  if (!placeholder) {
    record("error", "TV-ASK-NOPLACEHOLDER", "a question was not answered: the chat card could not be created");
    try {
      await ChatMessage.create({
        content: `<div class="tusks-vault-answer is-error"><p>${t("chat.failed")}</p><p class="notes">TV-ASK-NOPLACEHOLDER</p></div>`,
        speaker,
        whisper: [author.id, game.user.id],
      });
    } catch {
      // Nothing can be posted at all. The record above is the whole report.
    }
    releaseAskSlot(author.id);
    return;
  }

  try {
    // One shape either way. `answerLocally` returns what `ask_lore` returns,
    // so everything below this line — the citation chips, the lore-gap
    // styling, the error codes, the diagnostics — is the bridge's code doing
    // exactly what it already did.
    const result = lite ? await answerLocally(query, author) : await callWithAddressRecovery(
      activeBridge,
      "ask_lore",
      {
        question: query,
        asker: {
          id: author.id,
          displayName: author.name,
          isGM: author.isGM === true,
        },
      },
      ASK_TIMEOUT_MS
    );

    const text = result?.content?.map(part => part.text ?? "").join("\n").trim();
    const meta = result?._meta?.[MODULE_ID] ?? {};
    const body = text || t("chat.noAnswer");

    const classes = ["tusks-vault-answer"];
    if (result?.isError) classes.push("is-error");
    if (meta.declined) classes.push("is-declined");
    if (meta.loreGapRecorded) classes.push("is-gap");

    // An answer assembled from documents not everyone can open must not be
    // posted where not everyone should read it.
    //
    // Per-asker scoping bounds what goes INTO an answer; it says nothing about
    // who reads the answer that comes out. Set *Who sees the answer* to
    // "Everyone, in the open" and the two settings quietly cancel: a player's
    // own backstory is retrieved correctly, then published to the table. The
    // feature leaks on exactly the case that motivates it.
    //
    // So the retrieval decides the audience when the retrieval was narrow. The
    // placeholder is re-aimed rather than a second message posted, because a
    // whisper that arrives next to a public "Consulting the archive…" tells the
    // table something happened and denies them only the content.
    //
    // Gated on scoping being ON. Under the default the GM has said "answer from
    // everything in the folder" and separately said "post answers in the open";
    // overriding the second because the first did what it was told would leave
    // *Everyone, in the open* quietly not working, with nothing to explain it.
    // Two settings fighting is worse than either losing. The spoiler trade-off
    // that remains is the documented one, and *Who may ask* is its answer.
    const narrowedToAsker = meta.narrowed && whisper.length === 0 && scopingIsOn();

    // NOT wrapped in a <p>. `renderAnswer` emits block-level markup —
    // paragraphs, lists, blockquotes — and a <p> cannot contain any of them:
    // the browser auto-closes it at the first block child, leaving an empty
    // paragraph that then collects the `:first-child` margin rule meant for
    // the real first block.
    const answerHtml = `<div class="${classes.join(" ")}">` +
      `${renderAnswer(body, meta.sources)}` +
      `${corpusNote(meta, narrowedToAsker ? author.id : null)}` +
      `${upsellFooter(meta)}</div>`;

    if (narrowedToAsker) {
      // NEVER NARROW A DOCUMENT THAT WAS ALREADY PUBLIC.
      //
      // This used to re-aim the placeholder — set `whisper` and the restricted
      // content in one atomic update — which is the right instinct and the
      // wrong direction. The document already exists on every client with
      // `whisper: []`, so the safety of narrowing it rests on Foundry receiving
      // the update, re-evaluating `ChatMessage#visible` and REMOVING an element
      // it has already rendered. Widening an audience is always safe; narrowing
      // one after the fact depends on behaviour this module does not control.
      //
      // So the restricted content never touches a document that was ever
      // public. The placeholder stays public and becomes a notice — the table
      // still sees that something was asked and answered, which is what the
      // re-aiming was for — and the answer itself is a new message that is
      // whispered from the moment it exists.
      record("info", "TV-ANSWER-NARROWED", "private sources; answered privately rather than publicly");
      await placeholder.update({
        content: `<em class="tusks-vault-thinking">${t("chat.narrowedPublicly")}</em>`,
      });
      await ChatMessage.create({
        content: answerHtml,
        speaker,
        whisper: whisperTargets("asker", author.id),
      });
    } else {
      await placeholder.update({ content: answerHtml });
    }
  } catch (err) {
    warn("ask_lore failed", err);
    // The BridgeError constructor already logged the cause with its code; this
    // records that a QUESTION was lost to it, which is the thing a GM reading
    // the log back is trying to line up. Length, never the text: this log is
    // written to be pasted into a public issue.
    // Always its own code, with the cause named in `extra`. Reusing the
    // transport's code here would put two identical lines in the log for one
    // failure, and the useful reading is "the bridge broke, AND a question was
    // lost to it" — two events, correlated, not one repeated.
    record("error", "TV-ASK-FAILED", "question not answered", {
      cause: err?.code ?? "(not a bridge error)",
      questionLength: String(query ?? "").length,
      askerIsGM: author.isGM === true,
    });
    // THROUGH THE SCRUBBER, not just the escaper. This prose can be the Vault
    // address or Google's own error text, which carries a cloud project number
    // — and when the GM is the asker and answers go to everyone, this card is
    // public. The scrubber already has a pattern for exactly this content; it
    // was only ever pointed at the diagnostics buffer.
    const detail = escapeHtml(scrubForDump(err?.message ?? String(err)));
    const askerIsRelay = author.id === game.user.id;

    // The placeholder KEEPS its audience. Narrowing the whisper to the GM here
    // does not hide the failure — it deletes the message from the asker's log,
    // so what they see is "Consulting the archive…" quietly disappearing and no
    // answer ever arriving. That is the single most confusing outcome the
    // module can produce, and it looks exactly like the module being broken.
    //
    // The DETAIL is still the GM's alone: a bad token, a switched-off surface
    // or an address pointing at the wrong server is not the table's business,
    // and it is only actionable by them. When the GM is the asker there is one
    // audience and one message, which is the ordinary single-GM table.
    // The code goes in the visible text on purpose. It is the one part of a
    // failure a GM can quote verbatim into an issue without transcribing prose,
    // and it maps to exactly one branch in this file.
    const code = escapeHtml(err?.code ?? "TV-ASK-FAILED");
    // Some failures are one click from fixed, and saying so is the difference
    // between a GM re-pairing and a GM filing a bug. The big one is a changed
    // Foundry ADDRESS: a credential is bound to the exact scheme://host:port it
    // was paired from, so opening the same world on a LAN IP instead of
    // localhost, or putting Foundry behind TLS, produces a correct 403 that
    // reads like the bridge is broken. It is not — it just needs pairing again
    // from the address the GM now uses.
    const hint = escapeHtml(recoveryHint(err));
    const hintHtml = hint ? `<p class="notes">${hint}</p>` : "";
    await placeholder.update({
      content: askerIsRelay
        ? `<div class="tusks-vault-answer is-error"><p>${t("chat.failed")}</p><p class="notes">${detail}</p>${hintHtml}<p class="notes">${code}</p></div>`
        : `<div class="tusks-vault-answer is-error"><p>${t("chat.failed")}</p></div>`,
    }).catch?.(() => {
      // The card could not be updated — the message was deleted, or the same
      // veto that can stop a creation stopped this. The GM whisper below is
      // then the only report there will be, so it must still run.
    });

    if (!askerIsRelay) {
      // The hint belongs here MORE than in the branch above, not less. A GM
      // whose Foundry address changed is a GM hosting for a table — so the
      // asker is a player, the card the table sees carries no detail, and this
      // whisper is the only place the GM is told anything at all.
      await ChatMessage.create({
        content: `<div class="tusks-vault-answer is-error"><p>${t("chat.failed")}</p><p class="notes">${detail}</p>${hintHtml}<p class="notes">${code}</p></div>`,
        speaker,
        whisper: [game.user.id],
      });
    }
  } finally {
    releaseAskSlot(author.id);
  }
}

// ─── Which ground is this card painted on? ───────────────────────────────────

/**
 * The palette cannot be chosen from Foundry's theme, and this was found the
 * only way it could be — by installing the module and measuring.
 *
 * Foundry v13+ puts `theme-dark` on the root when the UI is dark, and keying
 * the palette off that is the obvious approach. It is wrong, because the GAME
 * SYSTEM decides what a chat card is painted on, independently of Foundry's UI
 * theme. Measured on dnd5e 5.3.3 under a dark Foundry: the root carries
 * `theme-dark`, and the chat message underneath is `rgb(232,232,239)` with
 * near-black text. The dark palette — pale amber, pale violet — was landing on
 * that at contrast ratios of 1.8:1 to 2.1:1, against the 4.5:1 that small text
 * needs. Legible in a screenshot of the sidebar; not legible on the card.
 *
 * So the ground is measured rather than inferred. The CSS keeps a theme-based
 * palette as a fallback for the case where this never runs, and the class these
 * functions add outranks it.
 */

/** The sRGB relative luminance at which black and white text contrast equally.
 *  Above it, the ground is light and wants the dark palette. */
const LIGHT_GROUND_LUMINANCE = 0.18;

/** Parse what `getComputedStyle` returns. Browsers answer `rgb(a, b, c)` or
 *  `rgba(a, b, c, d)`; anything else — a colour function, a keyword — is
 *  reported as unknown rather than guessed at. */
function parseRgb(value) {
  const text = String(value ?? "").trim();
  // Anchored on the function name, not just "some numbers in a string". A
  // colour this does not understand — `color(display-p3 1 1 1)`, say — would
  // otherwise have its digits scraped out of the COLOUR SPACE NAME: `p3`
  // yields a 3, and the card is confidently painted for the wrong ground.
  if (!/^rgba?\(/i.test(text)) return null;
  const parts = text.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return null;
  const [r, g, b] = parts.slice(0, 3).map(Number);
  const a = parts.length > 3 ? Number(parts[3]) : 1;
  if ([r, g, b, a].some(n => !Number.isFinite(n))) return null;
  return { r, g, b, a };
}

/** WCAG relative luminance. */
function relativeLuminance({ r, g, b }) {
  const channel = v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * Walk up from the card to the first ancestor that actually paints a
 * background, and say whether it is dark.
 *
 * Returns `null` when nothing opaque is found, which is a real answer and not
 * a failure: it means the card is sitting on whatever is behind the whole
 * application, and the CSS fallback is a better guess than anything measurable
 * here. An `alpha` under a half is treated as not-the-ground for the same
 * reason — a wash lets the layer beneath decide the contrast.
 */
function groundIsDark(element) {
  for (let node = element; node; node = node.parentElement) {
    const rgb = parseRgb(getComputedStyle(node).backgroundColor);
    if (rgb && rgb.a >= 0.5) return relativeLuminance(rgb) < LIGHT_GROUND_LUMINANCE;
  }
  return null;
}

/**
 * Stamp the measured ground onto every card in a rendered chat message.
 *
 * Idempotent, because the hook fires more than once per message — dnd5e
 * re-renders its own cards, and each pass arrives here again.
 */
/**
 * Whatever Foundry handed a render hook, as a DOM node.
 *
 * Foundry passed jQuery in older versions and a bare element now, so the
 * common shim is `html[0] ?? html`. That shim is WRONG for a form: an
 * HTMLFormElement is array-like over its own controls, so `form[0]` is its
 * first button — and a hook written that way silently searches inside one
 * button and finds nothing, with no error anywhere. Discriminate on jQuery's
 * own version marker instead, which only jQuery has.
 */
function domRoot(html) {
  return typeof html?.jquery === "string" ? html[0] : html;
}

function markGround(html) {
  const root = domRoot(html);
  if (!root?.querySelectorAll) return;
  for (const card of root.querySelectorAll(".tusks-vault-answer, .tusks-vault-thinking")) {
    const dark = groundIsDark(card);
    // Both classes come off first, so a card re-rendered onto a different
    // ground is not left carrying the previous answer.
    card.classList.remove("tv-on-dark", "tv-on-light");
    if (dark === null) continue;
    card.classList.add(dark ? "tv-on-dark" : "tv-on-light");
  }
}

/**
 * Measure on the next frame, not in the hook.
 *
 * `renderChatMessageHTML` fires while the message element is still being
 * BUILT — measured in Foundry v14, `document.contains(html)` is false and
 * `getComputedStyle(html).backgroundColor` is the empty string. An element
 * outside the document has no computed style, so measuring in the hook walks
 * the whole parent chain, finds nothing opaque, and correctly concludes it
 * cannot tell — leaving every card unmarked and the palette on its fallback.
 * The symptom is the bug this whole mechanism exists to fix, still present,
 * with the fix apparently installed.
 *
 * A frame later the element is in the log and has a real background. Deferring
 * costs one frame of the card being painted from the fallback palette, which
 * is a repaint nobody sees; measuring too early costs the feature.
 */
function markGroundWhenPainted(html) {
  const run = () => markGround(html);
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 0);
}

// `renderChatMessageHTML` is the v13+ hook and passes the message's own
// element. `renderChatMessage` is its predecessor and passes jQuery; it is
// registered too because this module's declared minimum is v13 and the
// changeover sits close to it. Both paths are idempotent, so a Foundry that
// fires both costs nothing.
Hooks.on("renderChatMessageHTML", (_message, html) => markGroundWhenPainted(html));
Hooks.on("renderChatMessage", (_message, html) => markGroundWhenPainted(html));

// ─── Boot ────────────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  try {
    registerSettings();
    log("initialised");
  } catch (err) {
    // Loud on purpose. Every failure mode downstream of this looks like the
    // module simply is not there.
    console.error(`${MODULE_ID} | settings registration FAILED:`, err);
    ui.notifications?.error?.(`Tusk's Vault failed to start: ${err?.message ?? err}`);
  }
});

Hooks.once("ready", async () => {
  if (!game.user.isGM) return;

  // Ahead of the enabled check on purpose: a world switched off today can be
  // switched on tomorrow, and it should not still be carrying its policy in a
  // format nothing reads any more. Only the elected GM writes, and a failure
  // here must not stop the connection below — the defaults are serviceable.
  // Read BEFORE `migratePolicy` writes it. A world in which the module has
  // never completed a ready pass is a world in which it has never run, which is
  // the only safe signal for "this is a first install" — the setting that
  // decides which half answers is not, because a GM happy on the default never
  // writes it and a fresh world is indistinguishable from theirs.
  const worldIsNew = !setting("policyMigrated");

  if (game.users.activeGM?.id === game.user.id) {
    try {
      await migratePolicy();
    } catch (err) {
      warn("access policy migration failed", err);
      record("error", "TV-POLICY-MIGRATE-FAIL", err?.message ?? String(err));
    }

    // An upgrade is not a first run. Marking it done here is what keeps the
    // question away from the worlds that already made this choice by living
    // with it.
    if (!worldIsNew && !setting("setupDone")) {
      await adoptPreviousScope();
      await setSetting("setupDone", true).catch(() => {});
    } else if (worldIsNew && !setting("setupDone")) {
      // NOT awaited. The dialog resolves when a person clicks it, which may be
      // never — and everything below this line is how the module connects and
      // starts working. Awaiting a human would mean a GM who alt-tabbed away
      // from the welcome screen came back to a module that had not loaded.
      firstRunOpen = true;
      void runFirstRun()
        .catch(err => {
          warn("first-run setup failed", err);
          record("error", "TV-SETUP-FAIL", err?.message ?? String(err));
        })
        .finally(() => {
          firstRunOpen = false;
        });
    }
  }

  if (!setting("enabled")) return;

  // Nothing to connect to in lite mode, and telling a GM to go and pair with
  // an app they have deliberately not installed is the worst first-run message
  // this module could produce.
  if (usingLite()) {
    log("lite mode: answering from journals on this client");
    return;
  }

  // Wrapped, like the migration above it. A throw here is in a `ready` hook
  // Foundry does not await, so it would be an unhandled rejection that leaves
  // the module looking loaded and silently unpaired.
  const activeBridge = await resolveBridge().catch(err => {
    warn("could not resolve the bridge on load", err);
    record("error", "TV-READY-BRIDGE", "the bridge could not be resolved at load", {
      cause: err?.code ?? err?.name ?? "(unknown)",
    });
    return null;
  });
  if (!activeBridge) {
    // Not an error — a fresh install is simply unpaired, and nagging every GM
    // at every load would be worse than the one notification that tells them
    // where the button is. Silent while the welcome screen is up, which is
    // already asking this question in more useful words.
    if (!firstRunOpen) ui.notifications.info(t("notify.needsPairing"));
    return;
  }

  try {
    await activeBridge.initialize();
    log(`connected to ${activeBridge.base}`);
  } catch (err) {
    warn("connect failed", err);
    ui.notifications.warn(t("notify.connectFailed", { detail: err?.message ?? "" }));
  }
});

// Exposed for the browser console and for anyone scripting against the module.
// Deliberately small: pairing, and a direct ask.
globalThis.TusksVault = {
  /** One-command diagnosis. `TusksVault.selfTest()` in the F12 console reports
   *  everything needed to tell "the module did not load" apart from "the module
   *  loaded and declined". */
  selfTest() {
    // Every read here is optional. This is the function a GM runs when nothing
    // else works, so it has to survive the very breakage it is reporting on —
    // a self-test that throws tells them strictly less than no self-test.
    const mod = game.modules?.get?.(MODULE_ID);
    const hooks = Hooks.events?.chatMessage ?? [];
    const report = {
      moduleActive: mod?.active,
      moduleVersion: mod?.version,
      settingsRegistered: [...(game.settings?.settings?.keys?.() ?? [])].filter(k => k.startsWith(MODULE_ID)).length,
      chatHooks: hooks.length,
      // An explicit marker rather than reading the function's own source:
      // `String(fn).includes(...)` breaks the moment anything minifies this
      // file, and it breaks SILENTLY — reporting "not registered" for a hook
      // that is, in the one dump written to diagnose exactly that.
      triggerHookRegistered: hooks.some(h => h.fn?.tusksVaultTrigger === true),
      enabled: setting("enabled"),
      answerSource: setting("answerSource"),
      liteAnswersEnabled: setting("liteAnswers"),
      liteFolder: setting("liteFolder"),
      // How many folders the lore tree actually covers. One means either no
      // subfolders or — before 1.1.0 read the tree — the only number it could
      // ever report, so a report showing more is also evidence the walk ran.
      liteFolderCount: loreFolderIds()?.size ?? 0,
      liteScope: setting("liteScope"),
      // Whether the scope and the journal permissions combine into the one
      // arrangement where a note a player wrote can influence an answer drawn
      // from lore they cannot read.
      playersMayWriteJournals: (game.users?.filter?.(u => !u.isGM && u.hasPermission?.("JOURNAL_CREATE")) ?? []).length,
      liteModel: setting("liteModel"),
      // The LENGTH, never the key. This dump is written to be pasted into a
      // public issue tracker, and the rule that governs the bridge token
      // governs a provider credential that can be spent.
      geminiKeyLength: (setting("geminiKey") || "").length,
      liteCorpusSize: (() => {
        try {
          return collectLore(game.user).length;
        } catch {
          return "(unavailable)";
        }
      })(),
      askPolicy: setting("askPolicy"),
      replyVisibility: setting("replyVisibility"),
      // The COUNT, never the ids. A user id is not a secret, but a diagnostics
      // dump is written for a public issue tracker and "who is allowed to ask"
      // is nobody else's business. The count answers the only question a bug
      // report needs: whether the list is why someone was refused.
      allowListSize: allowedUserIds().length,
      policyMigrated: setting("policyMigrated"),
      trigger: setting("triggerCommand"),
      botName: setting("botName"),
      // CLASSIFIED, not quoted — same reasoning as allowListSize above. The
      // default is loopback and says nothing about anybody, but a hand-set
      // address is a hostname the GM chose, and hostnames are routinely a
      // person's name or their machine's ("vault.<firstname>-desktop.lan").
      // Every question a bug report actually asks of this field — is one set,
      // is it loopback, is it usable — is answered without quoting it.
      bridgeUrl: describeBridgeUrl(setting("bridgeUrl")),
      // An address that is not an absolute origin is the failure that looks
      // like Vault refusing the connection: fetch resolves it against the
      // Foundry page and the module ends up asking Foundry for the lore.
      bridgeUrlUsable: isVaultAddress((setting("bridgeUrl") || "").trim().replace(/\/+$/, "")),
      bridgeTokenLength: (setting("bridgeToken") || "").length,
      usingDefaults: warnedAboutSettings,
      parsesConfiguredCommand: !!parseTrigger(`/${setting("triggerCommand") || "tusk"} example question`),
      // Reported separately from the configured one on purpose. A renamed
      // trigger and a broken trigger both present as "/tusk is not a valid
      // command"; these two flags are what tell them apart at a glance.
      parsesLiteralSlashTusk: !!parseTrigger("/tusk example question"),
      // The shape v14 actually delivers. Reported apart from the bare string
      // because the two disagreeing is the whole signature of a Foundry that
      // has changed what it hands the hook.
      parsesWrappedCommand: !!parseTrigger("<p>/tusk example question</p>"),
    };
    console.log(`${MODULE_ID} | self-test`, report);
    return report;
  },
  /**
   * Everything known about this install, as one block of text to paste.
   *
   * `selfTest` says what the module looks like NOW; this says what it has been
   * doing. Together they cover the two questions a bug report has to answer —
   * what is configured, and what happened — without a round trip asking the GM
   * to run three more things.
   *
   * Deliberately a string rather than an object: a console object collapses
   * behind "…" and gets pasted as "[object Object]", which cost this project a
   * round trip once already.
   */
  diagnostics() {
    const report = TusksVault.selfTest();
    const lines = [
      "── Tusk's Vault module diagnostics ──",
      `generated : ${new Date().toISOString()}`,
      `module    : v${report.moduleVersion ?? "?"} (active: ${report.moduleActive})`,
      `foundry   : ${game.version ?? "?"}`,
      `system    : ${game.system?.id ?? "?"} ${game.system?.version ?? ""}`.trim(),
      `protocol  : ${PROTOCOL_VERSION}`,
      "",
      "── configuration ──",
    ];
    for (const [key, value] of Object.entries(report)) {
      if (key === "moduleVersion" || key === "moduleActive") continue;
      lines.push(`${key.padEnd(24)}: ${value}`);
    }
    lines.push("", `── events (${events.length}, oldest first) ──`);
    if (events.length === 0) lines.push("(nothing recorded this session)");
    for (const e of events) {
      const extra = e.extra ? `  ${JSON.stringify(e.extra)}` : "";
      lines.push(`${e.at}  ${e.level.toUpperCase().padEnd(5)} ${e.code.padEnd(24)} ${e.message}${extra}`);
    }
    lines.push(
      "",
      "No question text, answer text, token or world name is recorded — this is",
      "written to be safe to paste into a public issue."
    );
    const text = lines.join("\n");
    console.log(text);
    return text;
  },
  /** The raw events, for anything that would rather filter than read. */
  events: () => events.slice(),
  pair: runPairing,
  discover: discoverVault,
  /** Re-run the scope check by hand. It fires on its own when the setting
   *  changes, but the risky arrangement can also be reached from the other
   *  side — by granting a player journal permissions long after the scope was
   *  set — and nothing about that change passes through this module. */
  checkScope: warnIfScopeIsWideOpen,
  /** Answer from this client's journals, bypassing the chat trigger and the
   *  relay election. The symmetric counterpart to `ask`, and the way a GM
   *  checks that their lore folder is being read at all without spending a
   *  question — or, when answers are on, without waiting for their turn to be
   *  the elected relay. */
  askLocal: (question) => answerLocally(question, game.user),
  /** Just the corpus, so "why did it not find that?" is answerable. Names and
   *  sizes only — the text is the GM's own and does not need reprinting. */
  lore: () => collectLore(game.user).map(d => ({ name: d.name, characters: d.text.length })),
  /**
   * What this key can actually reach.
   *
   * Google retires models on its own schedule, so the module's default will go
   * stale no matter when it ships. The error says which model to move to, and
   * this says what the alternatives are — which turns "no longer available"
   * from a dead end into a one-line fix a GM can apply themselves in module
   * settings, without waiting for a release.
   */
  async models() {
    const key = (setting("geminiKey") || "").trim();
    if (!key) return t("lite.noKey");
    const all = await fetchGeminiModels(key);
    const allowed = rankModels(all).map(m => m.name);
    return {
      usable: allowed,
      best: allowed[0] ?? null,
      configured: setting("liteModel"),
      // The rest are real models this key can reach; lite does not pick them
      // because they are outside the flash / flash-lite policy. A GM may still
      // type one into the setting.
      others: all.filter(name => !allowed.includes(name)).sort(),
    };
  },
  ask: (question) =>
    getBridge()?.callTool(
      "ask_lore",
      { question, asker: { id: game.user.id, displayName: game.user.name, isGM: game.user.isGM } },
      ASK_TIMEOUT_MS
    ),
};
