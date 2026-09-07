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

/** The sibling project: session recordings into written chronicles, which then
 *  become lore Vault can answer from. Worth naming on the comparison because it
 *  is a reason to move up that has nothing to do with this module. */
const TOMES_SITE = "https://kochitusker.github.io/Tusks-Tomes/";

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
const ROLES = globalThis.CONST?.USER_ROLES ?? {
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

function setSetting(key, value) {
  return game.settings.set(MODULE_ID, key, value);
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
   * Which half answers.
   *
   * The bridge is the default because that is what this module IS — the
   * Foundry end of Tusk's Vault. Lite is the front door for someone who has
   * not installed it yet, and saying so in the choice labels is the whole
   * upsell: there is no paywall here, only a download.
   */
  game.settings.register(MODULE_ID, "answerSource", {
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

  game.settings.register(MODULE_ID, "bridgeUrl", {
    name: t("settings.bridgeUrl.name"),
    hint: t("settings.bridgeUrl.hint"),
    scope: "client",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "bridgeToken", {
    scope: "client",
    config: false, // A secret has no business in a settings form.
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "liteFolder", {
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
  game.settings.register(MODULE_ID, "liteAnswers", {
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
  game.settings.register(MODULE_ID, "liteFilters", {
    name: t("settings.liteFilters.name"),
    hint: t("settings.liteFilters.hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "liteModel", {
    name: t("settings.liteModel.name"),
    hint: t("settings.liteModel.hint"),
    scope: "world",
    config: true,
    type: String,
    default: LITE_MODEL_DEFAULT,
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
  game.settings.register(MODULE_ID, "geminiKey", {
    scope: "client",
    config: false,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "enabled", {
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
  game.settings.register(MODULE_ID, "accessMode", {
    scope: "world",
    config: false,
    type: String,
    default: "whisper",
  });

  game.settings.register(MODULE_ID, "policyMigrated", {
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
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
  game.settings.register(MODULE_ID, "askPolicy", {
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
  game.settings.register(MODULE_ID, "allowedUsers", {
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
  game.settings.register(MODULE_ID, "replyVisibility", {
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

  game.settings.register(MODULE_ID, "triggerCommand", {
    name: t("settings.triggerCommand.name"),
    hint: t("settings.triggerCommand.hint"),
    scope: "world",
    config: true,
    type: String,
    default: "tusk",
  });

  game.settings.register(MODULE_ID, "botName", {
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

  game.settings.registerMenu(MODULE_ID, "connect", {
    name: t("settings.connect.name"),
    label: t("settings.connect.label"),
    hint: t("settings.connect.hint"),
    icon: "fas fa-link",
    type: menuShim(runPairing),
    restricted: true,
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
  dialog.render({ force: true });
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
  dialog.render({ force: true });
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
  dialog.render({ force: true });
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
  dialog.render({ force: true });
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
    dialog.render({ force: true });
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
  return game.folders?.find?.(f => f.type === "JournalEntry" && String(f.name).trim().toLowerCase() === name) ?? null;
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
 * The documents this asker is allowed to have answered from.
 *
 * Filtered by Foundry's own ownership, per asker — which is per-player lore
 * scoping, the thing the project has tracked as the real fix for the spoiler
 * problem and the blocking follow-on for the Foundry surface. Lite gets it
 * almost free, because a journal entry carries permissions and a file on disk
 * does not. Vault, reading a folder, has no way to know any of this.
 *
 * The GM's own client assembles this, so it must ask about the ASKER rather
 * than about itself — `game.user` here is the relay, not the person who typed.
 */
function collectLore(asker) {
  const folder = loreFolder();
  if (!folder) return [];
  const entries = game.journal?.filter?.(e => e.folder?.id === folder.id) ?? [];
  const docs = [];
  for (const entry of entries) {
    // OBSERVER rather than LIMITED: a limited-ownership journal shows its name
    // and nothing else, and answering from a document somebody may only see the
    // name of is the leak this filter exists to prevent.
    if (asker && entry.testUserPermission && !entry.testUserPermission(asker, "OBSERVER")) continue;
    const pages = entry.pages?.contents ?? entry.pages ?? [];
    const text = [...pages]
      .map(p => journalText(p?.text?.content ?? ""))
      .filter(Boolean)
      .join("\n\n");
    if (text) docs.push({ name: String(entry.name ?? "Untitled"), uuid: entry.uuid, text });
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
        const count = haystack.split(term).length - 1;
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

/** A short piece of the document around the first match, for the search card. */
function excerptFor(doc, question) {
  const terms = searchTerms(question);
  const lower = doc.text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  const start = Math.max(0, (at < 0 ? 0 : at) - 60);
  const slice = doc.text.slice(start, start + 240).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${start + 240 < doc.text.length ? "…" : ""}`;
}

/**
 * Answer by finding, not by generating.
 *
 * Costs nothing, sends nothing anywhere, and needs no credential — which is
 * what makes it the default. Returns the same shape as everything else so the
 * card renders identically.
 */
function searchAnswer(question, docs, extra = {}) {
  const ranked = rankLore(question, docs).slice(0, LITE_SEARCH_RESULTS);
  if (ranked.length === 0) {
    return {
      content: [{ type: "text", text: t("lite.noMatches") }],
      _meta: { [MODULE_ID]: { loreGapRecorded: true, source: "lite-search", upsell: true, ...extra } },
    };
  }
  const lines = [t("lite.searchHeader", { count: ranked.length })];
  for (const doc of ranked) lines.push(`- ${excerptFor(doc, question)} [${doc.name}]`);
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    _meta: { [MODULE_ID]: { source: "lite-search", upsell: true, ...extra } },
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

/** Every model this key can reach, unfiltered. Names only. */
async function fetchGeminiModels(key) {
  const res = await fetchJson(LITE_ENDPOINT, { headers: { "x-goog-api-key": key } }, 20_000);
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

/** As much of the corpus as fits, best matches first, each labelled so the
 *  model can cite it by name. */
function buildPrompt(question, docs) {
  const ranked = rankLore(question, docs);
  const ordered = ranked.length > 0 ? ranked : docs;
  const parts = [];
  let budget = LITE_CORPUS_CHAR_CAP;
  let included = 0;
  for (const doc of ordered) {
    const block = `[SOURCE: ${doc.name}]\n${doc.text}\n`;
    if (block.length > budget) continue;
    parts.push(block);
    budget -= block.length;
    included += 1;
  }
  return {
    included,
    total: docs.length,
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

  return {
    content: [{ type: "text", text }],
    _meta: {
      [MODULE_ID]: {
        source: "lite-gemini",
        upsell: true,
        loreGapRecorded: text.toLowerCase().includes(LITE_LORE_GAP_FRAGMENT),
        corpus: { included: prompt.included, total: prompt.total },
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
  return fetchJson(
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
  if (game.user?.isGM) {
    try {
      await setSetting("liteModel", best);
    } catch (err) {
      warn("could not save the replacement model", err);
    }
  }
  ui.notifications?.info?.(t("notify.modelMoved", { from: current, to: best }));
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
function renderAnswer(text) {
  // Control characters are stripped before anything else so the fenced-code
  // placeholders below cannot be forged by a model emitting one.
  const safe = escapeHtml(String(text ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ""));

  const fences = [];
  const withoutFences = safe.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code) => {
    fences.push(`<pre><code>${code.replace(/\n+$/, "")}</code></pre>`);
    return `${FENCE_SENTINEL}${fences.length - 1}${FENCE_SENTINEL}`;
  });

  const html = renderBlocks(withoutFences);
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
function renderBlocks(escaped) {
  const lines = escaped.split("\n");
  const out = [];
  let paragraph = [];
  let list = null; // { tag: "ul" | "ol", items: string[] }
  let quote = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(paragraph.join("<br>"))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map(item => `<li>${inline(item)}</li>`).join("");
    out.push(`<${list.tag}>${items}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    out.push(`<blockquote>${inline(quote.join("<br>"))}</blockquote>`);
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
      out.push(`<p class="tusks-vault-heading">${inline(heading[2])}</p>`);
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
function inline(escaped) {
  return citations(
    escaped
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
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
function citations(escaped) {
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
    .replace(/\[([^\]\n<>]{1,60})\]/g, (_m, name) => chip("source", name.trim()));
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
  if (!meta?.upsell) return "";
  const line = meta.keyMissing ? t("lite.footerNoKey") : t("lite.footer");
  return `<p class="tusks-vault-upsell">${escapeHtml(line)} ` +
    `<a href="${DOCS_SITE}">${escapeHtml(t("lite.footerLink"))}</a> · ` +
    `<a href="${VAULT_REPO}">${escapeHtml(t("lite.footerRepo"))}</a></p>`;
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

Hooks.on("chatMessage", (_chatLog, message) => {
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
});

// ─── Chat: the GM's side ─────────────────────────────────────────────────────

Hooks.on("createChatMessage", async (message) => {
  const query = message.flags?.[MODULE_ID]?.query;
  if (!query) return;
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
    return;
  }

  const whisper = whisperTargets(visibility, author.id);

  // In `gm` visibility the asker is not in that audience, so from their seat
  // the question goes into the log and nothing ever comes back — which is what
  // a broken module looks like. One line telling them where the answer went is
  // the whole difference.
  if (whisper.length > 0 && !whisper.includes(author.id)) {
    await ChatMessage.create({
      content: t("chat.answeredToGM"),
      speaker,
      whisper: [author.id],
    });
  }

  // A placeholder goes up immediately. An answer can take 5-10 seconds on a
  // subscription provider and longer behind a queue; silence for that long
  // reads as broken.
  const placeholder = await ChatMessage.create({
    content: `<em class="tusks-vault-thinking">${t("chat.thinking")}</em>`,
    speaker,
    whisper,
  });

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
    const meta = result?._meta?.["tusks-vault"] ?? {};
    const body = text || t("chat.noAnswer");

    const classes = ["tusks-vault-answer"];
    if (result?.isError) classes.push("is-error");
    if (meta.declined) classes.push("is-declined");
    if (meta.loreGapRecorded) classes.push("is-gap");

    // NOT wrapped in a <p>. `renderAnswer` emits block-level markup —
    // paragraphs, lists, blockquotes — and a <p> cannot contain any of them:
    // the browser auto-closes it at the first block child, leaving an empty
    // paragraph that then collects the `:first-child` margin rule meant for
    // the real first block.
    await placeholder.update({
      content: `<div class="${classes.join(" ")}">${renderAnswer(body)}${upsellFooter(meta)}</div>`,
    });
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
    const detail = escapeHtml(err?.message ?? String(err));
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
  }
});

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
  if (game.users.activeGM?.id === game.user.id) {
    try {
      await migratePolicy();
    } catch (err) {
      warn("access policy migration failed", err);
      record("error", "TV-POLICY-MIGRATE-FAIL", err?.message ?? String(err));
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

  const activeBridge = await resolveBridge();
  if (!activeBridge) {
    // Not an error — a fresh install is simply unpaired, and nagging every GM
    // at every load would be worse than the one notification that tells them
    // where the button is.
    ui.notifications.info(t("notify.needsPairing"));
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
      triggerHookRegistered: hooks.some(h => String(h.fn).includes("parseTrigger")),
      enabled: setting("enabled"),
      answerSource: setting("answerSource"),
      liteAnswersEnabled: setting("liteAnswers"),
      liteFolder: setting("liteFolder"),
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
