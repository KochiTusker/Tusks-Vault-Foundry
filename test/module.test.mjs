// The Foundry module ships through a package registry to strangers, and every
// mistake this file catches is one that installs cleanly and then misbehaves
// on someone else's machine. There is no CI that can run Foundry, so the
// manifest is checked here or nowhere.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DOCS_SITE, MODULE_DIR, REPO_ROOT, collectModuleFiles, readManifest, verifyManifest } from "../tools/lib/module.mjs";
import { buildZip } from "../tools/build-module.mjs";

const manifest = readManifest();

describe("module manifest", () => {
  it("passes every publishable invariant", () => {
    expect(verifyManifest(manifest)).toEqual([]);
  });

  it("declares a minimum Foundry version", () => {
    expect(manifest.compatibility.minimum).toBeTruthy();
  });
});

describe("manifest invariants actually catch things", () => {
  // A validator nobody has seen fail is a validator nobody should trust.
  it("rejects a download URL that is not version-pinned", () => {
    const problems = verifyManifest({
      ...manifest,
      download: "https://example.invalid/releases/latest/download/module.zip",
    });
    expect(problems.join(" ")).toContain("does not contain version");
  });

  it("rejects a manifest URL that IS version-pinned", () => {
    const problems = verifyManifest({
      ...manifest,
      manifest: `https://example.invalid/releases/download/foundry-v${manifest.version}/module.json`,
    });
    expect(problems.join(" ")).toContain("stable");
  });

  it("rejects an esmodule that is not in the module directory", () => {
    const problems = verifyManifest({ ...manifest, esmodules: ["scripts/does-not-exist.js"] });
    expect(problems.join(" ")).toContain("not in the module directory");
  });

  it("rejects a non-kebab-case id", () => {
    // The id is the flag namespace and the settings namespace. Changing it
    // orphans both.
    expect(verifyManifest({ ...manifest, id: "Tusks_Vault" }).join(" ")).toContain("kebab-case");
  });
});

describe("module source", () => {
  const script = fs.readFileSync(path.join(MODULE_DIR, "scripts", "tusk.js"), "utf-8");

  it("uses the manifest id as its module constant", () => {
    // Foundry namespaces settings and flags by module id. If these two ever
    // disagree, every setting silently reads its default and the GM's client
    // never recognises a question it just posted.
    expect(script).toContain(`const MODULE_ID = "${manifest.id}";`);
  });

  /** One registration block, by setting key. Slicing between two key names
   *  breaks the moment a setting is added between them — which it did. */
  function registration(key) {
    const at = script.indexOf(`register(MODULE_ID, "${key}", {`);
    expect(at, `no registration for "${key}"`).toBeGreaterThan(-1);
    const end = script.indexOf("\n  });", at);
    return script.slice(at, end);
  }

  it("keeps every credential in client scope, and out of the settings form", () => {
    // The sharpest trap in this integration: world-scoped settings are
    // distributed to EVERY connected client, so a secret in world scope is a
    // secret every player can read out of game.settings. For the bridge token
    // that means querying the campaign directly, ignoring the table's access
    // mode; for the Gemini key it means spending the GM's money.
    for (const key of ["bridgeToken", "geminiKey"]) {
      const block = registration(key);
      expect(block, key).toContain('scope: "client"');
      expect(block, key).not.toContain('scope: "world"');
      // A secret rendered into a form is a secret in a screenshot.
      expect(block, key).toContain("config: false");
    }
  });

  it("registers no credential this test does not know about", () => {
    // A future secret added in world scope would pass every test above by
    // simply not being listed in one. This fails instead.
    const suspicious = [...script.matchAll(/register\(MODULE_ID, "([A-Za-z]*(?:[Kk]ey|[Tt]oken|[Ss]ecret|[Pp]assword))"/g)]
      .map(m => m[1]);
    expect(new Set(suspicious)).toEqual(new Set(["bridgeToken", "geminiKey"]));
  });

  it("derives the asker from the document author, never from the payload", () => {
    // A player can set arbitrary flags on a message they create, so a flag
    // claiming isGM proves nothing. Foundry sets `author` server-side.
    expect(script).toContain("const author = message.author;");
    expect(script).toContain("isGM: author.isGM === true");
  });

  it("elects a single relay so the table is not answered twice", () => {
    expect(script).toContain("game.users.activeGM");
  });

  it("escapes answers before it does anything else to them", () => {
    // The answer is model output assembled from the GM's own notes and it
    // lands in a log every player renders. Escaping FIRST is what stops stray
    // markup in a lore note becoming script on every client at the table, and
    // it is an ordering property rather than a line: the renderer grew a block
    // walker, an inline pass and a citation pass, and every one of them has to
    // run on text that is already escaped.
    const body = script.slice(script.indexOf("function renderAnswer"));
    const opening = body.slice(0, body.indexOf("\n}"));
    // escapeHtml is reached before any tag of ours is emitted.
    expect(opening.indexOf("escapeHtml(")).toBeGreaterThan(-1);
    expect(opening.indexOf("escapeHtml(")).toBeLessThan(opening.indexOf("renderBlocks("));
  });

  it("emits chips as text content, never as an attribute value", () => {
    // A citation label is drawn from the model's output. It is already escaped
    // by the time `chip()` sees it, but putting it in an attribute would need
    // a different escaping rule than the one applied — so it never goes in one.
    const chip = script.slice(script.indexOf("function chip("));
    expect(chip.slice(0, 200)).toContain('class="tusks-vault-cite is-${kind}"');
    expect(chip.slice(0, 200)).not.toMatch(/(title|data-[a-z]+|style)="\$\{/);
  });

  it("ships every file the manifest references", () => {
    const present = new Set(collectModuleFiles().map(f => f.relPath));
    for (const file of [...manifest.esmodules, ...manifest.styles]) {
      expect(present.has(file)).toBe(true);
    }
  });
});

describe("the Gemini model default", () => {
  const script = fs.readFileSync(path.join(MODULE_DIR, "scripts", "tusk.js"), "utf-8");

  it("is written down exactly once", () => {
    // It was written three times — the defaults table, the registration and
    // the request — and when Google retired the model it had to be corrected
    // in all three or the one that was missed kept answering 404. Whoever
    // fixes the next retirement should have one line to change.
    const literals = [...script.matchAll(/"(gemini-[\w.-]+)"/g)].map(m => m[1]);
    expect(literals.length, `found ${literals.join(", ")}`).toBe(1);
    expect(script).toContain("const LITE_MODEL_DEFAULT =");
  });

  it("is referenced by name everywhere it is used", () => {
    // Three call sites, one constant.
    const uses = [...script.matchAll(/LITE_MODEL_DEFAULT/g)].length;
    expect(uses).toBeGreaterThanOrEqual(4);
  });

  it("keeps a way to find out what a key can actually reach", () => {
    // The default will go stale again whenever Google retires a model. The
    // provider's error names the replacement, and this lists the rest — so a
    // GM is never blocked waiting for a module release.
    expect(script).toContain("async models()");
    expect(script).toContain("supportedGenerationMethods");
  });
});

describe("answer styling", () => {
  const script = fs.readFileSync(path.join(MODULE_DIR, "scripts", "tusk.js"), "utf-8");
  const css = fs.readFileSync(path.join(MODULE_DIR, "styles", "tusks-vault.css"), "utf-8");

  it("styles every citation kind the renderer can emit", () => {
    // The renderer and the stylesheet are two files that have to agree. An
    // unstyled chip does not fail anything — it renders as bare text in the
    // middle of an answer, which reads as the feature being broken.
    const kinds = [...script.matchAll(/chip\("([a-z]+)"/g)].map(m => m[1]);
    expect(kinds.length).toBeGreaterThan(3);
    for (const kind of new Set(kinds)) {
      expect(css).toContain(`.tusks-vault-cite.is-${kind}`);
    }
  });

  it("styles every card state the relay can set", () => {
    const states = [...script.matchAll(/classes\.push\("is-([a-z]+)"\)/g)].map(m => m[1]);
    for (const state of new Set([...states, "error"])) {
      expect(css).toContain(`.tusks-vault-answer.is-${state}`);
    }
  });

  it("signals the unsourced kinds by shape as well as by hue", () => {
    // Roughly one man in twelve cannot separate these hues. Speculation and a
    // guardrail cut are the two a reader must not mistake for a sourced claim,
    // so both carry a dashed border that does not depend on colour at all.
    for (const kind of ["speculation", "sanitised"]) {
      const at = css.indexOf(`.tusks-vault-cite.is-${kind}`);
      expect(at).toBeGreaterThan(-1);
      expect(css.slice(at, at + 220)).toContain("border-style: dashed");
    }
  });

  it("declares each palette value exactly once", () => {
    // Three selectors can choose a palette — the measured class for each
    // ground, and the media-query fallback. If each restated its own hexes,
    // correcting a hue would mean correcting it in three places, and the one
    // that got missed would be wrong only for readers in that state.
    const literals = [...css.matchAll(/(--tv-[a-z-]+)\s*:\s*(#[0-9a-f]{3,8}|\d+%)/gi)];
    for (const [, name] of literals) {
      expect(name).toMatch(/^--tv-[ld]-/);
    }
    const names = literals.map(m => m[1]);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(15);
  });

  it("clears WCAG AA against the ground each palette is chosen for", () => {
    // Not a theoretical check. Shipped once at 1.8:1 to 2.1:1, because the
    // palette was picked from Foundry's theme class while the game system
    // painted the card itself — see markGround() in the script. These are the
    // two grounds that decision now resolves to: dnd5e's measured chat card,
    // and a dark one. Small text needs 4.5.
    const LIGHT_GROUND = "#e8e8ef";
    const DARK_GROUND = "#1b1c20";
    const luminance = hex => {
      const n = parseInt(hex.slice(1), 16);
      const channel = v => {
        const s = ((n >> v) & 255) / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
    };
    const ratio = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    // A regex LITERAL, not a string handed to RegExp: the escapes are the
    // thing being matched here, and a string literal eats them.
    const all = [...css.matchAll(/--tv-([ld])-([a-z]+)\s*:\s*(#[0-9a-f]{6})/gi)];
    const palette = prefix => all.filter(m => m[1].toLowerCase() === prefix).map(m => [m[0], m[2], m[3]]);

    const failures = [];
    for (const [prefix, ground] of [["l", LIGHT_GROUND], ["d", DARK_GROUND]]) {
      const entries = palette(prefix);
      expect(entries.length).toBeGreaterThan(6);
      for (const [, name, hex] of entries) {
        const r = ratio(hex, ground);
        if (r < 4.5) failures.push(`--tv-${prefix}-${name} ${hex} on ${ground} = ${r.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("gives the two palettes the same shape", () => {
    const of = prefix =>
      new Set([...css.matchAll(new RegExp(`--tv-${prefix}-([a-z]+)\s*:`, "g"))].map(m => m[1]));
    const light = of("l");
    const dark = of("d");
    expect(light.size).toBeGreaterThan(8);
    expect([...dark].sort()).toEqual([...light].sort());
  });

  it("lets the measured ground outrank the guessed one", () => {
    // The fallback carries no specificity, so whatever order these rules end
    // up in, a card that has actually been measured keeps its answer.
    const media = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
    expect(media.slice(0, 200)).toContain(":where(");
    expect(css).toContain(".tusks-vault-answer.tv-on-light");
    expect(css).toContain(".tusks-vault-answer.tv-on-dark");
  });

  it("styles exactly the ground classes the script stamps on", () => {
    // The measurement and the stylesheet are two files that have to agree, and
    // a mismatch is silent: the class lands, nothing selects it, and the card
    // keeps whatever the fallback guessed.
    const stamped = [...script.matchAll(/classList\.(?:add|remove)\(([^)]*)\)/g)]
      .flatMap(m => [...m[1].matchAll(/"(tv-on-[a-z]+)"/g)].map(x => x[1]));
    expect(new Set(stamped)).toEqual(new Set(["tv-on-dark", "tv-on-light"]));
    for (const cls of new Set(stamped)) expect(css).toContain(`.${cls}`);
  });

  it("scopes every rule under the module's own classes", () => {
    // A bare element selector here would restyle every chat card at the table,
    // including the game system's.
    // Comments are stripped first: this file explains itself at length, and a
    // naive scan reads every comment block as a selector.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = [...bare.matchAll(/(^|[}{])\s*([^@}{;\s][^{}]*?)\s*\{/g)].map(m => m[2].trim());
    expect(selectors.length).toBeGreaterThan(10);
    const unscoped = selectors.filter(sel =>
      sel.split(",").some(part => !part.includes("tusks-vault"))
    );
    expect(unscoped).toEqual([]);
  });
});

describe("the module points at one documentation site", () => {
  const script = fs.readFileSync(path.join(MODULE_DIR, "scripts", "tusk.js"), "utf-8");

  it("links the source repository as well as the guide", () => {
    // Two destinations on purpose: one is where you learn what Vault is, the
    // other is where you read what it does. Somebody arriving from a module in
    // a live game wants a different one from somebody evaluating the code.
    const script = fs.readFileSync(path.join(MODULE_DIR, "scripts", "tusk.js"), "utf-8");
    const repo = script.match(/const VAULT_REPO = "([^"]+)"/)?.[1];
    expect(repo).toBe("https://github.com/KochiTusker/Tusks-Vault");
    expect(manifest.description).toContain(repo);
  });

  it("uses the same URL the package browser shows", () => {
    // Foundry renders `url` as the package's website. A card in chat pointing
    // somewhere else is two answers to one question, and the one a GM sees
    // depends on where they happened to click.
    const inScript = script.match(/const DOCS_SITE = "([^"]+)"/)?.[1];
    expect(inScript).toBe(DOCS_SITE);
    expect(manifest.url).toBe(DOCS_SITE);
    expect(manifest.description).toContain(DOCS_SITE);
  });

  it("builds the link itself rather than putting it through the escaper", () => {
    // `renderAnswer` escapes everything, correctly — that text came from a
    // model. A link written into it would arrive as visible angle brackets, so
    // the footer is module chrome assembled separately.
    const footer = script.slice(script.indexOf("function upsellFooter("));
    expect(footer.slice(0, 400)).toContain("<a href=");
    expect(footer.slice(0, 400)).toContain("escapeHtml(");
  });

  it("does not wrap block-level answer markup in a paragraph", () => {
    // renderAnswer emits <p>, <ul>, <blockquote>. A <p> cannot contain any of
    // them: the browser auto-closes it at the first block child and leaves an
    // empty paragraph that collects the :first-child margin meant for the real
    // first block.
    expect(script).not.toMatch(/<p>\$\{renderAnswer/);
  });
});

describe("the upgrade comparison only claims real features", () => {
  const lang = JSON.parse(fs.readFileSync(path.join(MODULE_DIR, "lang", "en.json"), "utf-8"));
  const rows = lang.TUSKS_VAULT.dialog.why.rows;
  const script = fs.readFileSync(path.join(MODULE_DIR, "scripts", "tusk.js"), "utf-8");

  it("renders every row the script asks for", () => {
    const listed = script.slice(script.indexOf("const UPGRADE_ROWS"), script.indexOf("async function openWhyUpgrade"));
    const ids = [...listed.matchAll(/"([a-z]+)"/g)].map(m => m[1]);
    expect(ids.length).toBeGreaterThan(6);
    for (const id of ids) {
      expect(rows[id], id).toBeTruthy();
      for (const cell of ["label", "lite", "vault"]) expect(rows[id][cell], `${id}.${cell}`).toBeTruthy();
    }
  });

  it("does not advertise Codex, which Tusk's Vault does not have", () => {
    // It exists in Vault only as a line in a dev design note about what a
    // future adapter could be. Claude Code is the one that is implemented.
    const all = JSON.stringify(rows);
    expect(all).not.toMatch(/codex/i);
    expect(rows.paying.vault).toMatch(/Claude Code/);
  });

  it("describes the Tomes loop, and does not list it as a feature row", () => {
    // The claim is real: Vault's architecture has Tomes writing chronicles
    // into the shared Tusks-Lore folder that Vault reads, so no sync step
    // exists between them. That is a loop worth describing, not a bullet.
    const why = lang.TUSKS_VAULT.dialog.why;
    expect(rows.extras).toBeUndefined();
    expect(why.loopBody).toMatch(/record/i);
    expect(why.loopBody).toMatch(/session/i);
    expect(why.loopBody).toMatch(/Tomes/);
  });

  it("names the lore sources Vault actually reads", () => {
    // PDF, DOCX, TXT, MD and an Obsidian vault are all real; the row should
    // say so in words a GM recognises rather than listing extensions.
    expect(rows.lore.vault).toMatch(/Obsidian/);
    expect(rows.lore.vault).toMatch(/Word|docx/i);
  });

  it("says nothing about semantics or keywords", () => {
    // The row is about whether it finds your note, not how. A GM choosing
    // between two programs does not care which algorithm lost.
    const all = JSON.stringify(rows);
    expect(all).not.toMatch(/semantic|keyword|embedding|vector/i);
  });
});

describe("the security and privacy pages keep up with the code", () => {
  const script = fs.readFileSync(path.join(MODULE_DIR, "scripts", "tusk.js"), "utf-8");
  const security = fs.readFileSync(path.join(REPO_ROOT, "SECURITY.md"), "utf-8");
  const privacy = fs.readFileSync(path.join(REPO_ROOT, "docs", "Privacy.md"), "utf-8");
  const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf-8");

  it("documents every credential the module stores", () => {
    // A secret added without a line in SECURITY.md is a secret nobody was told
    // about. The same list also drives the client-scope assertions above, so
    // adding one means answering both questions.
    const secrets = [...script.matchAll(/register\(MODULE_ID, "([A-Za-z]*(?:[Kk]ey|[Tt]oken|[Ss]ecret|[Pp]assword))"/g)]
      .map(m => m[1]);
    expect(secrets.length).toBeGreaterThan(1);
    for (const name of new Set(secrets)) expect(security, name).toContain(name);
  });

  it("documents every host the module can talk to", () => {
    // The privacy page's central claim is that there are exactly two possible
    // destinations and you choose both. A third one added in code without a
    // line here would make that claim false and nothing else would notice.
    // Comments first, because a URL discussed in prose is not a request the
    // module makes — and the line-comment strip has to spare `https://`, whose
    // own `//` is preceded by a colon.
    const code = script
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const hosts = new Set(
      [...code.matchAll(/https?:\/\/([A-Za-z0-9.$among{}_-]+)/g)]
        .map(m => m[1].replace(/[:${].*$/, ""))
        .filter(Boolean)
    );
    expect(hosts.size).toBeGreaterThan(0);
    for (const host of hosts) expect(privacy, host).toContain(host);
  });

  it("describes both answer sources", () => {
    const modes = [...script.matchAll(/source: "lite-([a-z]+)"/g)].map(m => m[1]);
    expect(new Set(modes)).toEqual(new Set(["search", "gemini"]));
    expect(privacy).toMatch(/layer 1/i);
    expect(privacy).toMatch(/layer 2/i);
    expect(privacy).toMatch(/Bridge/);
  });

  it("explains what could go wrong in scenarios, not categories", () => {
    // "There is a residual risk" tells a reader nothing. Each scenario has to
    // say how it happens, what it costs them, and what shrinks it.
    expect(security).toMatch(/What could actually go wrong/i);
    for (const heading of ["How", "What it costs you", "What shrinks it"]) {
      expect(security, heading).toContain(heading);
    }
  });

  it("points at the licence for warranty and liability rather than inventing terms", () => {
    // MIT already disclaims both, and it is the operative text. Paraphrasing
    // it into something that reads like a separate agreement would be worse
    // than useless.
    expect(security).toMatch(/MIT/);
    expect(security).toMatch(/without warranty/i);
    // The line wraps in the source, and the emphasis markers sit outside the
    // words, so match across both rather than a fixed spelling.
    expect(security).toMatch(/not\s+\**liable/i);
    expect(security).toContain("LICENSE");
    expect(security).toMatch(/legal\s+advice/i);
  });

  it("gives a way to report a vulnerability that is not a public issue", () => {
    expect(security).toMatch(/security\/advisories/);
    expect(security).toMatch(/not open a public issue/i);
  });

  it("is reachable from the README", () => {
    // A security page nobody is pointed at protects nobody.
    expect(readme).toContain("SECURITY.md");
    expect(readme).toContain("docs/Privacy.md");
  });

  it("says the two things a GM most needs to know before trusting it", () => {
    // Both were found the hard way in this repository's own history: world
    // scope publishes a secret to every player, and the data directory is
    // served without authentication.
    expect(security).toMatch(/world.{0,40}scope/is);
    expect(security).toMatch(/unauthenticated/i);
  });
});

describe("localisation", () => {
  const lang = JSON.parse(fs.readFileSync(path.join(MODULE_DIR, "lang", "en.json"), "utf-8"));
  const script = fs.readFileSync(path.join(MODULE_DIR, "scripts", "tusk.js"), "utf-8");

  function lookup(key) {
    return key.split(".").reduce((node, part) => (node == null ? undefined : node[part]), lang.TUSKS_VAULT);
  }

  it("defines every key the script asks for", () => {
    // A missing key renders as the raw key in the UI — visible, ugly, and the
    // sort of thing that only shows up in a screenshot from a stranger.
    const used = [...script.matchAll(/\bt\("([A-Za-z0-9_.]+)"/g)].map(m => m[1]);
    expect(used.length).toBeGreaterThan(10);
    const missing = used.filter(key => typeof lookup(key) !== "string");
    expect(missing).toEqual([]);
  });

  // "Could not find Tusk's Vault. Check it is running" is a dead end for the
  // one GM who most needs the message: theirs IS running, on a port outside the
  // scanned range. The two facts that end the dead end are the range and the
  // setting that overrides it, so both are asserted rather than trusted.
  describe("the not-found message can actually be acted on", () => {
    const notFound = lookup("notify.notFound");

    it("interpolates the scanned port range rather than hard-coding one", () => {
      expect(notFound).toContain("{range}");
      // A literal range in the string would silently go stale the moment
      // DISCOVERY_PORT_COUNT changed.
      expect(notFound).not.toMatch(/3000\s*[-–]\s*\d+/);
      expect(script).toContain('t("notify.notFound", { range: DISCOVERY_RANGE_LABEL })');
    });

    it("builds that range from the constants discovery actually uses", () => {
      expect(script).toMatch(
        /DISCOVERY_RANGE_LABEL\s*=\s*`\$\{DISCOVERY_BASE_PORT\}-\$\{DISCOVERY_BASE_PORT \+ DISCOVERY_PORT_COUNT - 1\}`/,
      );
    });

    it("names the setting that fixes a non-default port", () => {
      // The exact label the GM is looking for in the settings panel.
      expect(notFound).toContain(lang.TUSKS_VAULT.settings.bridgeUrl.name);
    });

    it("says the two things that are actually required", () => {
      expect(notFound).toMatch(/same computer/i);
      expect(notFound).toMatch(/port/i);
    });
  });

  // A bridge credential is bound to the exact scheme://host:port it paired
  // from. That is the right security property and it is NOT being relaxed —
  // but it means the ordinary act of opening the same world on a LAN IP, or
  // behind TLS, produces a correct 403 that reads like the module is broken.
  // It is one click from fixed, so the failure has to say so.
  describe("a recoverable bridge failure says how to recover", () => {
    it("offers the re-pair hint on the auth failures, and only those", () => {
      expect(script).toContain('if (code === "TV-BRIDGE-403" || code === "TV-BRIDGE-401") return t("chat.hintRepair");');
      // A hint on every failure is a hint nobody reads.
      expect(script).toMatch(/function recoveryHint\(err\)[\s\S]{0,600}?return "";\n\}/);
    });

    it("names the change that actually causes it, and the control that fixes it", () => {
      const hint = lookup("chat.hintRepair");
      expect(hint).toMatch(/address/i);
      expect(hint).toMatch(/localhost/i);
      // The button the GM has to press, by the label it carries.
      expect(hint).toContain(lang.TUSKS_VAULT.settings.connect.label);
    });

    it("renders the hint into the failure card the GM sees", () => {
      expect(script).toContain("const hint = escapeHtml(recoveryHint(err));");
      expect(script).toContain("${hintHtml}");
    });
  });
});

describe("the dependency is stated where an installer will see it", () => {
  // Foundry has no way to express a dependency on something that is not a
  // Foundry package: `relationships.requires` resolves ids against the package
  // registry. So the package browser's description is the ONLY place a person
  // deciding whether to click Install can learn they are installing a bridge to
  // an app they do not have yet.
  it("says the module is a bridge", () => {
    expect(manifest.description).toMatch(/bridge/i);
  });

  it("names Tusk's Vault as the thing it bridges to", () => {
    expect(manifest.description).toMatch(/Tusk's Vault/);
  });

  it("sends the reader to the documentation site", () => {
    expect(manifest.description).toContain(DOCS_SITE);
    expect(manifest.url).toBe(DOCS_SITE);
  });

  it("rejects a description that drops the warning", () => {
    const problems = verifyManifest({ ...manifest, description: "Ask your lore in chat." });
    expect(problems.join(" ")).toContain("must say this is a bridge");
  });

  it("rejects a description that stops linking the docs", () => {
    const problems = verifyManifest({ ...manifest, description: "A bridge to something." });
    expect(problems.join(" ")).toContain("must link");
  });

  it("rejects an attempt to declare Vault as a Foundry package", () => {
    // The obvious-looking fix for all of the above, and it would make Foundry
    // try to resolve "tusks-vault-app" out of the package registry and block
    // the install on a package that will never be listed there.
    const problems = verifyManifest({
      ...manifest,
      relationships: { requires: [{ id: "tusks-vault-app", type: "application" }] },
    });
    expect(problems.join(" ")).toContain("belongs in the description");
  });

  it("accepts a relationship on something Foundry can actually resolve", () => {
    expect(
      verifyManifest({ ...manifest, relationships: { requires: [{ id: "lib-wrapper", type: "module" }] } })
    ).toEqual([]);
  });
});

describe("release URLs", () => {
  it("rejects a manifest and a download from different repositories", () => {
    // An update check that reads one project's version and installs another's
    // files is the kind of fault that only shows up on a stranger's machine.
    const problems = verifyManifest({
      ...manifest,
      download: `https://github.com/KochiTusker/Some-Other-Repo/releases/download/foundry-v${manifest.version}/module.zip`,
    });
    expect(problems.join(" ")).toContain("different repositories");
  });

  it("rejects a download that is not served from a release", () => {
    const problems = verifyManifest({
      ...manifest,
      download: `https://example.invalid/${manifest.version}/module.zip`,
    });
    expect(problems.join(" ")).toContain("must be a GitHub releases URL");
  });

  it("requires a verified compatibility version", () => {
    const problems = verifyManifest({ ...manifest, compatibility: { minimum: "13" } });
    expect(problems.join(" ")).toContain("compatibility.verified");
  });

  it("notices when package.json has drifted from the manifest", () => {
    const problems = verifyManifest({ ...manifest, version: "9.9.9" });
    expect(problems.join(" ")).toContain("package.json says");
  });
});

describe("the zip a stranger installs", () => {
  /** Entry names out of the central directory. Written by hand because Node has
   *  no zip reader, and because the thing under test is the archive's own
   *  bytes — a helper that re-derived them from the file list would assert
   *  nothing. */
  function entryNames(zip) {
    const end = findEocd(zip);
    const count = zip.readUInt16LE(end + 10);
    let offset = zip.readUInt32LE(end + 16);
    const names = [];
    for (let i = 0; i < count; i += 1) {
      const nameLength = zip.readUInt16LE(offset + 28);
      const extraLength = zip.readUInt16LE(offset + 30);
      const commentLength = zip.readUInt16LE(offset + 32);
      names.push(zip.toString("utf-8", offset + 46, offset + 46 + nameLength));
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return names;
  }

  function findEocd(zip) {
    for (let i = zip.length - 22; i >= 0; i -= 1) {
      if (zip.readUInt32LE(i) === 0x06054b50) return i;
    }
    throw new Error("no end-of-central-directory record — this is not a zip");
  }

  const zip = buildZip(collectModuleFiles());
  const names = entryNames(zip);

  it("puts module.json at the archive root", () => {
    // Foundry unzips the download and reads the manifest out of it. Wrapping
    // the files in a folder puts every path one level below where the manifest
    // says it is, and the module installs and then loads nothing.
    expect(names).toContain("module.json");
  });

  it("uses forward slashes, on every platform", () => {
    // Zip entry names are POSIX-shaped by specification. A backslash here — the
    // default if paths are joined with node:path on Windows — unpacks as one
    // file with a slash in its name.
    expect(names.some(name => name.includes("\\"))).toBe(false);
    expect(names).toContain("scripts/tusk.js");
  });

  it("ships every file the manifest names, and nothing that is not a module file", () => {
    for (const file of [...manifest.esmodules, ...manifest.styles]) {
      expect(names).toContain(file);
    }
    // No README, no tests, no package manifest: everything outside `module/`
    // stays outside the archive.
    expect(names.some(name => /^(README|package|test)/i.test(name))).toBe(false);
  });
});
