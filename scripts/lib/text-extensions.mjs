// Which tracked files are supposed to be text?
//
// Two complementary lists, because two different questions are being asked.
//
// TEXT_EXTENSIONS answers "should this file have been readable?" — used by
// audit-current-tree.mjs to warn when a file it expected to scan turned out
// to contain NUL bytes and therefore skipped every content layer.
//
// BINARY_EXTENSIONS answers the inverse, "is this file ALLOWED to contain NUL
// bytes?" — used by the test that fails the build on any other file that
// does. An allowlist rather than a denylist because the failure mode being
// guarded against is a file silently leaving the scanner's reach, and a
// denylist only catches the shapes someone thought of.

/** Extensions whose files must be readable as text. */
export const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".md",
  ".markdown",
  ".css",
  ".scss",
  ".html",
  ".htm",
  ".svg",
  ".xml",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".txt",
  ".csv",
  ".tsv",
  ".sh",
  ".bash",
  ".ps1",
  ".psm1",
  ".bat",
  ".cmd",
  ".example",
  ".lock",
]);
// Note: dotfiles like `.gitignore` are deliberately absent. `path.extname`
// returns "" for them, so listing them here would be a line that can never
// match — a list that lies about its own coverage. They are still covered by
// the NUL-byte test, which allowlists binaries instead of listing text.

/** Extensions that legitimately hold NUL bytes. Everything else must not. */
export const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".bmp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".7z",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".webm",
  ".mov",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".wasm",
  ".node",
  ".bin",
  ".enc",
  ".salt",
]);

/** True when a path's extension says it may contain NUL bytes.
 *
 *  Reads the extension from the BASENAME only: `some.dir/pre-push` has no
 *  extension, and scanning the whole path for the last dot would find the
 *  one in the directory name. */
export function isBinaryPath(filePath) {
  const base = filePath.toLowerCase().split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  // `dot < 1` covers both "no dot" and a leading-dot filename like
  // `.gitignore`, which has a name rather than an extension.
  if (dot < 1) return false;
  return BINARY_EXTENSIONS.has(base.slice(dot));
}
