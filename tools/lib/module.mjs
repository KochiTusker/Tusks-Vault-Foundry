// Shared knowledge about the Foundry module's shape: where it lives, what
// belongs in a release, and what makes a manifest valid.
//
// Split out from the build script so the test suite can assert the manifest
// invariants without building a zip. Foundry's package registry installs from
// whatever the manifest says, and the failure modes are all silent-until-a-user
// hits them: a download URL pointing at the wrong tag installs the old version
// forever, and an `esmodules` entry naming a file that is not in the zip loads
// a module that does nothing at all.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const MODULE_DIR = path.join(REPO_ROOT, "module");
export const OUTPUT_DIR = path.join(REPO_ROOT, "dist-module");

/** Nothing is excluded, and that is the point: in this repo `module/` holds
 *  exactly what ships, and everything else — README, tooling, tests, package
 *  manifest — lives outside it. An exclusion list is a thing that goes stale
 *  silently, and the cost of a miss is junk inside a zip a stranger installs. */
const EXCLUDED = new Set();

export function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(MODULE_DIR, "module.json"), "utf-8"));
}

/** Every file that goes in the zip, with paths relative to the module root and
 *  forward slashes — zip entries are always POSIX-shaped, including on
 *  Windows, and a backslash here produces an archive Foundry unpacks into a
 *  single file with a slash in its name. */
export function collectModuleFiles(dir = MODULE_DIR, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (EXCLUDED.has(relPath)) continue;
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectModuleFiles(absPath, relPath));
    else out.push({ absPath, relPath });
  }
  return out;
}

const SEMVER = /^\d+\.\d+\.\d+$/;

/** Where every piece of user-facing documentation lives. The module is a
 *  bridge; the thing it bridges to owns the tutorials. */
export const DOCS_SITE = "https://kochitusker.github.io/Tusks-Vault/";

/** What Foundry's `relationships` entries are allowed to be. Not a guess —
 *  `RelatedPackage.type` is one of these three, and nothing else resolves. */
const PACKAGE_TYPES = new Set(["module", "system", "world"]);

/**
 * Everything that must hold before a release is publishable.
 *
 * Returns a list of problems rather than throwing, so a caller can report all
 * of them at once instead of making the maintainer fix them one build at a
 * time.
 */
export function verifyManifest(manifest) {
  const problems = [];
  const present = new Set(collectModuleFiles().map(f => f.relPath));

  for (const field of ["id", "title", "description", "version", "compatibility", "manifest", "download"]) {
    if (!manifest[field]) problems.push(`missing required field: ${field}`);
  }

  if (manifest.version && !SEMVER.test(manifest.version)) {
    problems.push(`version must be x.y.z, got "${manifest.version}"`);
  }

  // Foundry derives the module's data path and flag namespace from `id`, so a
  // change here silently orphans every world's settings and every flag already
  // written onto a chat message.
  if (manifest.id && !/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) {
    problems.push(`id must be lowercase kebab-case, got "${manifest.id}"`);
  }

  for (const key of ["esmodules", "styles"]) {
    for (const file of manifest[key] ?? []) {
      if (!present.has(file)) problems.push(`${key} names "${file}", which is not in the module directory`);
    }
  }

  for (const language of manifest.languages ?? []) {
    if (!present.has(language.path)) {
      problems.push(`languages names "${language.path}", which is not in the module directory`);
    }
  }

  // The registry polls `manifest` at a stable URL and fetches `download` at a
  // versioned one. A download URL that does not carry this version is the
  // classic broken release: users install once and never see an update again,
  // because every check finds the same file.
  if (manifest.download && manifest.version && !manifest.download.includes(manifest.version)) {
    problems.push(
      `download URL does not contain version ${manifest.version} — every update would fetch the same artifact`
    );
  }

  if (manifest.manifest && manifest.version && manifest.manifest.includes(manifest.version)) {
    problems.push(
      "manifest URL is version-pinned — it must be a stable 'latest' URL or the registry can never see a new release"
    );
  }

  if (manifest.compatibility && !manifest.compatibility.minimum) {
    problems.push("compatibility.minimum is required");
  }

  // Foundry shows `verified` in the package browser as "tested up to". Absent,
  // the listing reads as untested against every version anyone is running.
  if (manifest.compatibility && !manifest.compatibility.verified) {
    problems.push("compatibility.verified is required — the listing shows it as the version this was tested against");
  }

  if (!Array.isArray(manifest.authors) || manifest.authors.length === 0) {
    problems.push("authors must name at least one person");
  }

  // Foundry unzips `download` and looks for the manifest inside. Every install
  // path assumes it is at the archive root beside the directories it names, and
  // an archive built around a wrapping folder installs as a module whose files
  // are all one level deeper than the manifest claims.
  if (!present.has("module.json")) {
    problems.push("module.json must sit at the root of the module directory, so it lands at the root of the zip");
  }

  problems.push(...verifyDependencyIsStated(manifest));
  problems.push(...verifyReleaseUrls(manifest));
  problems.push(...verifyVersionAgreement(manifest));

  return problems;
}

/**
 * Both halves of what this module is have to be in the description, because
 * neither can be anywhere Foundry understands.
 *
 * `relationships.requires` only expresses dependencies on other FOUNDRY
 * packages — its `type` is `module`, `system` or `world`, and an unresolvable
 * id sends Foundry looking in the package registry for something that will
 * never be listed there. Tusk's Vault is a desktop application, so the only
 * place a prospective installer learns anything is the text Foundry renders in
 * the package browser: this description.
 *
 * It has to carry two facts, and the check exists because the description once
 * carried only the first:
 *
 *   - Bridge needs a separate program. Someone installing in the belief they
 *     are getting the whole archivist otherwise gets a mode that cannot work
 *     and no idea why.
 *   - Lite does not. The description used to open "This is a bridge, not the
 *     archivist. It does nothing on its own", which was written before Lite
 *     existed and never revisited. It sent anyone who wanted the two-minute
 *     journals-only trial away to download a self-hosted app first — the same
 *     failure as the first case, pointing the other way, and worse because it
 *     turned people away at the only screen where they decide.
 */
function verifyDependencyIsStated(manifest) {
  const problems = [];
  const description = String(manifest.description ?? "");

  if (!/bridge/i.test(description)) {
    problems.push("description must say this is a bridge — the package browser is the only place an installer is told");
  }
  if (!/\blite\b/i.test(description)) {
    problems.push(
      "description must name Lite — the mode that needs nothing else installed. Without it the " +
        "text reads as though the module is useless on its own, which turns away the readers " +
        "most likely to try it"
    );
  }
  if (!description.includes(DOCS_SITE)) {
    problems.push(`description must link ${DOCS_SITE}, which is where everything else lives`);
  }

  // A guard rail rather than a rule anyone is about to break: declaring Vault
  // here is the obvious-looking fix for the above, and it would make Foundry
  // block installation on a package that does not exist.
  for (const key of ["requires", "recommends"]) {
    for (const related of manifest.relationships?.[key] ?? []) {
      if (!PACKAGE_TYPES.has(related.type ?? "module")) {
        problems.push(
          `relationships.${key} names "${related.id}" as type "${related.type}" — Foundry only understands ` +
            `${[...PACKAGE_TYPES].join(", ")}. An external app belongs in the description, not here.`
        );
      }
    }
  }

  return problems;
}

/** The two release URLs have to point at the same repository's releases, or an
 *  update check reads one project's version and installs another's files. */
function verifyReleaseUrls(manifest) {
  const problems = [];
  const repoOf = url => /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\//.exec(String(url ?? ""))?.[1];

  const manifestRepo = repoOf(manifest.manifest);
  const downloadRepo = repoOf(manifest.download);

  if (manifest.manifest && !manifestRepo) {
    problems.push("manifest URL must be a GitHub releases URL");
  }
  if (manifest.download && !downloadRepo) {
    problems.push("download URL must be a GitHub releases URL");
  }
  if (manifestRepo && downloadRepo && manifestRepo !== downloadRepo) {
    problems.push(`manifest and download point at different repositories (${manifestRepo} vs ${downloadRepo})`);
  }

  return problems;
}

/** The repo's own package.json is what a maintainer reads when they ask "what
 *  version are we on". Letting it drift from the manifest makes that answer
 *  wrong in the one place it is cheap to check. */
function verifyVersionAgreement(manifest) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"));
    if (pkg.version !== manifest.version) {
      return [`package.json says ${pkg.version} but module/module.json says ${manifest.version}`];
    }
  } catch {
    // No package.json is not a publishable problem; a mismatched one is.
  }
  return [];
}
