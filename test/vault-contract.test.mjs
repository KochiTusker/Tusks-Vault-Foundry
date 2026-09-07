// The wire contract between this module and Tusk's Vault.
//
// Vault lives in its own repository and carries the other half of this file:
// `src/server/mcp/foundry-contract.test.ts` there asserts Vault SERVES what
// these tests send. Neither suite can see the other, which is the point — the
// contract is written down in Vault's `docs/tooling/foundry-contract.md`, and each side
// independently asserts its own half of it.
//
// The rule: **a change to anything asserted here is a change to both
// repositories.** If an assertion below has to be edited to make a change land,
// Vault needs a matching change and `PROTOCOL_VERSION` probably needs a bump.
// This file is where you find that out, instead of a GM whose chat command
// stopped working.
//
// Deliberately built on its own small stub rather than sharing fixtures with
// module-runtime.test.mjs. A contract test that depends on another suite's
// fixtures drifts with them; this one asserts raw wire bytes and nothing else.

import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.resolve(HERE, "..", "module", "scripts", "tusk.js");

/** The revision named in Vault's docs/tooling/foundry-contract.md. */
const CONTRACT_PROTOCOL_VERSION = "2025-06-18";
const VAULT_BASE = "http://127.0.0.1:3000";

let world;
let calls;

function installStubs() {
  world = {
    settings: {
      enabled: true,
      accessMode: "whisper",
      triggerCommand: "tusk",
      botName: "Tusk",
      bridgeUrl: VAULT_BASE,
      bridgeToken: "a-token",
    },
    created: [],
    notifications: [],
    users: [
      { id: "gm", name: "The GM", isGM: true, active: true },
      { id: "p1", name: "A Player", isGM: false, active: true },
    ],
    pairStatus: { status: "approved", token: "fresh-token" },
    toolResult: { content: [{ type: "text", text: "An answer." }] },
    sessionId: "sess-1",
    forceStatus: null,
  };
  calls = [];

  const hooks = new Map();
  const record = (name, fn) => {
    if (!hooks.has(name)) hooks.set(name, []);
    hooks.get(name).push(fn);
  };
  globalThis.Hooks = { on: record, once: record, call: () => true };
  globalThis.__hooks = hooks;

  globalThis.game = {
    get user() {
      return world.users.find(u => u.id === "gm");
    },
    users: {
      get activeGM() {
        return world.users.find(u => u.isGM && u.active) ?? null;
      },
      filter: fn => world.users.filter(fn),
      find: fn => world.users.find(fn),
    },
    version: "14.365",
    world: { title: "A World" },
    system: { id: "dnd5e", version: "5.3.3" },
    modules: new Map([["tusks-vault", { active: true, version: "1.1.0" }]]),
    i18n: { format: key => key },
    settings: {
      get: (_ns, key) => world.settings[key],
      set: (_ns, key, value) => {
        world.settings[key] = value;
      },
      register: () => {},
      registerMenu: () => {},
    },
  };

  globalThis.ui = {
    notifications: {
      info: m => world.notifications.push(["info", m]),
      warn: m => world.notifications.push(["warn", m]),
      error: m => world.notifications.push(["error", m]),
    },
  };

  globalThis.ChatMessage = {
    create: vi.fn(async data => {
      const doc = { ...data, id: `m${world.created.length}`, update: vi.fn(async p => Object.assign(doc, p)) };
      world.created.push(doc);
      return doc;
    }),
  };

  globalThis.FormApplication = class {};
  globalThis.Dialog = class {
    render() {}
    close() {}
  };
  globalThis.foundry = {
    utils: { randomID: () => "rid" },
    applications: {
      api: {
        DialogV2: class {
          render() {}
          close() {}
        },
        ApplicationV2: class {
          constructor(options = {}) {
            this.options = options;
          }
        },
      },
    },
  };

  globalThis.fetch = vi.fn(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const reply = (status, payload, headers = {}) => ({
      ok: status < 400,
      status,
      headers: new Headers(headers),
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
    });

    const u = String(url);
    if (u.includes("/api/mcp/hello")) {
      if (!u.startsWith(VAULT_BASE)) return reply(404, "no");
      // `helloOverride` lets a test serve a Vault that speaks a different
      // protocol revision, which is the case the module has to refuse.
      return reply(
        200,
        world.helloOverride ?? { app: "tusks-vault", protocolVersions: [CONTRACT_PROTOCOL_VERSION] }
      );
    }
    if (u.includes("/api/mcp/pair/status")) return reply(200, world.pairStatus);
    if (u.includes("/api/mcp/pair/request")) return reply(200, { requestId: "req-1", code: "123456" });

    // Anything posted somewhere other than Vault answers the way a non-Vault
    // server does: a status, and a body carrying no `error` field at all.
    // Foundry itself returns 404 with HTML, which is the case a GM actually
    // hits when the stored address points at their own game server.
    if (u.endsWith("/mcp") && !u.startsWith(VAULT_BASE)) {
      return reply(404, "<!DOCTYPE html><title>404</title>Not Found");
    }

    if (world.forceStatus) return reply(world.forceStatus, { error: "refused" });

    const body = JSON.parse(options.body);
    if (body.method === "initialize") {
      return reply(200, { jsonrpc: "2.0", id: body.id, result: {} }, { "Mcp-Session-Id": world.sessionId });
    }
    if (String(body.method).startsWith("notifications/")) return reply(202, {});
    return reply(200, { jsonrpc: "2.0", id: body.id, result: world.toolResult });
  });
}

installStubs();
await import(pathToFileURL(MODULE_PATH).href);
const createChatMessageHook = globalThis.__hooks.get("createChatMessage")[0];
for (const fn of globalThis.__hooks.get("init") ?? []) fn();

// The module caches its bridge in a module-level singleton and rebuilds it only
// when the address or token changes. A fresh token per test is what forces each
// one to perform the full handshake it is trying to assert on.
let tokenCounter = 0;

beforeEach(() => {
  world.created = [];
  world.notifications = [];
  world.settings.bridgeUrl = VAULT_BASE;
  world.settings.bridgeToken = `token-${++tokenCounter}`;
  world.pairStatus = { status: "approved", token: "fresh-token" };
  world.toolResult = { content: [{ type: "text", text: "An answer." }] };
  world.sessionId = "sess-1";
  world.forceStatus = null;
  world.helloOverride = null;
  calls.length = 0;
  globalThis.fetch.mockClear();
});

/** Post a question document, the way Foundry does on every client. */
function ask(query = "who runs the harbour?", authorId = "p1") {
  return createChatMessageHook({
    flags: { "tusks-vault": { query } },
    author: world.users.find(u => u.id === authorId),
  });
}

const rpcCalls = () => calls.filter(c => c.url.endsWith("/mcp"));
const bodyOf = c => JSON.parse(c.options.body);

describe("discovery", () => {
  it("probes the port range the contract names, and only that", async () => {
    world.settings.bridgeUrl = "";
    await ask();
    const ports = calls
      .filter(c => c.url.includes("/api/mcp/hello"))
      .map(c => Number(new URL(c.url).port));
    expect(Math.min(...ports)).toBe(3000);
    expect(Math.max(...ports)).toBe(3019);
  });

  it("probes with a simple request, so no preflight is needed", async () => {
    world.settings.bridgeUrl = "";
    await ask();
    const probe = calls.find(c => c.url.includes("/api/mcp/hello"));
    // A custom header here would make every probe a preflight and break
    // discovery from a hosted Foundry. Only the abort signal may be present.
    expect(probe.options.headers).toBeUndefined();
    expect(probe.options.method ?? "GET").toBe("GET");
  });
});

describe("the session", () => {
  it("sends the headers the contract requires", async () => {
    await ask();
    const init = rpcCalls().map(bodyOf).findIndex(b => b.method === "initialize");
    const headers = rpcCalls()[init].options.headers;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe(`Bearer ${world.settings.bridgeToken}`);
    expect(headers["MCP-Protocol-Version"]).toBe(CONTRACT_PROTOCOL_VERSION);
  });

  it("asks for the protocol revision the contract names", async () => {
    await ask();
    const init = rpcCalls().map(bodyOf).find(b => b.method === "initialize");
    expect(init.params.protocolVersion).toBe(CONTRACT_PROTOCOL_VERSION);
    expect(init.jsonrpc).toBe("2.0");
  });

  it("reads the session out of the response header and echoes it back", async () => {
    await ask();
    const afterInit = rpcCalls().filter(c => bodyOf(c).method !== "initialize");
    expect(afterInit.length).toBeGreaterThan(0);
    for (const c of afterInit) expect(c.options.headers["Mcp-Session-Id"]).toBe("sess-1");
  });

  it("re-handshakes once on a 404 and retries, rather than failing the table", async () => {
    // Vault answers 404 for a lapsed session. Treating it as fatal would make
    // every Vault restart visible as a broken question.
    let seen = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (body?.method === "tools/call" && seen++ === 0) {
        calls.push({ url: String(url), options });
        return { ok: false, status: 404, headers: new Headers(), text: async () => "{}" };
      }
      return realFetch(url, options);
    });
    await ask();
    const initializes = rpcCalls().map(bodyOf).filter(b => b.method === "initialize");
    expect(initializes.length).toBeGreaterThanOrEqual(2);
    globalThis.fetch = realFetch;
  });
});

describe("ask_lore", () => {
  it("calls the tool by the name the contract fixes", async () => {
    await ask();
    const call = rpcCalls().map(bodyOf).find(b => b.method === "tools/call");
    expect(call.params.name).toBe("ask_lore");
  });

  it("sends the asker object Vault destructures", async () => {
    await ask("who runs the harbour?", "p1");
    const call = rpcCalls().map(bodyOf).find(b => b.method === "tools/call");
    expect(call.params.arguments).toEqual({
      question: "who runs the harbour?",
      // Taken from Foundry's server-side `author`, never from the payload.
      asker: { id: "p1", displayName: "A Player", isGM: false },
    });
  });

  it("renders the meta flags the contract promises into classes", async () => {
    world.toolResult = {
      content: [{ type: "text", text: "I do not know." }],
      _meta: { "tusks-vault": { declined: true, loreGapRecorded: true } },
    };
    await ask();
    const content = world.created.at(-1).content;
    expect(content).toContain("is-declined");
    expect(content).toContain("is-gap");
  });

  it("reads text out of content[].text", async () => {
    world.toolResult = { content: [{ type: "text", text: "The harbour master." }] };
    await ask();
    expect(world.created.at(-1).content).toContain("The harbour master.");
  });
});

describe("errors", () => {
  it("prints Vault's `error` string rather than inventing one", async () => {
    world.forceStatus = 403;
    await ask("q", "gm");
    expect(world.created.at(-1).content).toContain("refused");
  });

  // A credential is bound to the exact scheme://host:port it paired from, so a
  // GM who starts hosting for their table on a LAN IP gets a correct 403 that
  // reads like the module is broken. These assert the RENDERED card, because
  // asserting the source text of recoveryHint() cannot tell a right hint from
  // a wrong one — a mutation returning the unreachable hint for a 403 passed
  // the source-text version of this check.
  it("tells the GM to re-pair when the bridge refuses the credential", async () => {
    world.forceStatus = 403;
    await ask("q", "gm");
    // The i18n stub returns the KEY, which is the better contract assertion:
    // it pins which string the module chose, not how that string is worded.
    const card = world.created.at(-1).content;
    expect(card).toContain("TUSKS_VAULT.chat.hintRepair");
  });

  it("gives the GM the same hint when a PLAYER asked", async () => {
    // The case the hint exists for: the address changed because the GM is
    // hosting for a table, so the asker is a player and this whisper is the
    // only place the GM is told anything.
    world.forceStatus = 403;
    await ask("q", "p1");
    // Two cards exist: the placeholder the table sees (whispered to asker AND
    // GM, deliberately detail-free) and the GM-only card carrying the detail.
    // The hint belongs on the second.
    const whisper = world.created.find(
      m => Array.isArray(m.whisper) && m.whisper.length === 1 && m.whisper[0] === "gm"
    );
    expect(whisper).toBeTruthy();
    expect(whisper.content).toContain("TUSKS_VAULT.chat.hintRepair");
  });

  // Reported from a real table: the stored Vault address was Foundry's own
  // origin, so every question was asked of Foundry, which answered 404 with
  // HTML. The address is a well-formed origin, so isVaultAddress() passes and
  // the pre-call checks cannot see the problem — only a call can.
  it("re-discovers Vault when the stored address turns out to be something else", async () => {
    world.settings.bridgeUrl = "http://localhost:30000"; // Foundry, not Vault
    await ask("who runs the harbour?", "gm");

    // It must not simply report the 404: discovery finds Vault, the address is
    // adopted, and the question is answered on the retry.
    expect(world.settings.bridgeUrl).toBe(VAULT_BASE);
    expect(world.created.at(-1).content).toContain("An answer.");
  });

  it("does not re-probe twenty ports when Vault itself refuses", async () => {
    // A bad token or a switched-off surface is Vault answering, not a wrong
    // address. Recovering from it would turn one clear error into a slow one.
    world.forceStatus = 403;
    await ask("q", "gm");
    const probes = calls.filter(c => c.url.includes("/api/mcp/hello"));
    expect(probes).toHaveLength(0);
  });

  it("does not offer the re-pair hint for a failure re-pairing cannot fix", async () => {
    // A hint that fires on everything is a hint nobody reads.
    world.forceStatus = 500;
    await ask("q", "gm");
    expect(world.created.at(-1).content).not.toContain("TUSKS_VAULT.chat.hintRepair");
  });
});

// ─── Pairing ─────────────────────────────────────────────────────────────────
//
// This half of the contract used to stop at the session, and Vault's half did
// not: `foundry-contract.test.ts` pins the /pair/request body "verbatim from
// the module's runPairing()", the {requestId, code} reply, the protocol gate
// and the terminal `unknown` status. All four could be renamed or deleted here
// with the suite green, which is the failure mode the two-sided contract exists
// to prevent — Vault would keep serving a shape nothing sends.
describe("pairing", () => {
  const pairCalls = () => calls.filter(c => c.url.includes("/api/mcp/pair/"));

  it("sends the request body Vault destructures, by those exact names", async () => {
    await TusksVault.pair();
    const req = pairCalls().find(c => c.url.includes("/pair/request"));
    expect(req).toBeTruthy();
    const body = JSON.parse(req.options.body);
    // toEqual, not toMatchObject: an ADDED field is also a contract change,
    // and `surface` in particular is what fixes the credential's ceiling.
    expect(Object.keys(body).sort()).toEqual(
      ["clientName", "foundryVersion", "surface", "worldTitle"].sort()
    );
    expect(body.surface).toBe("foundry");
  });

  it("reads the reply out of the fields Vault actually returns", async () => {
    // Vault answers {requestId, code}. Reading {id, pin} would leave the module
    // polling `undefined` and showing the GM a blank confirmation code.
    world.pairStatus = { status: "approved", token: "fresh-token" };
    await TusksVault.pair();
    const status = pairCalls().find(c => c.url.includes("/pair/status"));
    expect(status).toBeTruthy();
    expect(status.url).toContain("requestId=req-1");
  });

  it("treats an unrecognised status as terminal, rather than polling until timeout", async () => {
    // Vault's half calls this out: "a new status string would hang the pairing
    // dialog". Unbounded polling here is a 150-second hang with no explanation.
    world.pairStatus = { status: "unknown" };
    const before = Date.now();
    await TusksVault.pair();
    expect(Date.now() - before).toBeLessThan(5000);
    // And it says so, rather than ending silently: notifications are
    // [level, message] tuples in this stub.
    expect(world.notifications.some(([level]) => level === "warn" || level === "error")).toBe(true);
  });

  it("refuses to pair when Vault does not advertise the protocol it speaks", async () => {
    world.helloOverride = { app: "tusks-vault", version: "9.9.9", protocolVersions: ["1999-01-01"] };
    await TusksVault.pair();
    // It must stop BEFORE asking for a pairing code — a code the GM approves
    // against a Vault that cannot answer them is worse than a refusal.
    expect(pairCalls().some(c => c.url.includes("/pair/request"))).toBe(false);
    world.helloOverride = null;
  });

  // The sharpest assertion in either repository, and it used to be vacuous: it
  // drove ask(), which never touches pairing, so a real POST to /pair/approve
  // inserted into runPairing() left all 451 tests green. It now drives the
  // pairing flow it is talking about.
  it("never calls the approve endpoint, even while pairing", async () => {
    // Approval is the dashboard's, same-origin. A module that could raise a
    // pairing prompt AND grant it would have paired itself.
    await TusksVault.pair();
    expect(pairCalls().length).toBeGreaterThan(0);
    expect(calls.some(c => c.url.includes("/pair/approve"))).toBe(false);
  });
});
