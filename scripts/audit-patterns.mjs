// Shared secret-shape patterns. Single source of truth for:
//   - scripts/audit-history.mjs  (one-shot full-history audit)
//   - scripts/audit-push-range.mjs (pre-push hook scan)
//   - scripts/audit-patterns.test.mjs (vitest suite)
//
// Each pattern matches a published, conservative shape for a known
// provider's credentials. Order matters: more specific patterns (e.g.
// Anthropic's sk-ant-…) must come before more general ones (OpenAI's sk-…)
// so the same string isn't double-flagged or attributed to the wrong
// provider.
//
// False negatives (a real secret that doesn't match any pattern) are
// acceptable — this is best-effort, not a guarantee. False positives are
// annoying but never security-relevant.

export const PATTERNS = [
  // ─── LLM provider keys ─────────────────────────────────────────────────
  { name: "Anthropic", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "OpenAI", re: /sk-[A-Za-z0-9_-]{16,}/g },
  { name: "Google", re: /AIza[A-Za-z0-9_-]{35,}/g },

  // ─── Chat / messaging ──────────────────────────────────────────────────
  // Discord bot token — base64url.base64url.base64url, conservative on the
  // first segment so we don't redact short identifiers separated by dots.
  { name: "Discord", re: /[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}/g },
  // Slack tokens (bot, user, refresh, app, service).
  { name: "Slack", re: /xox[abpsr]-[A-Za-z0-9-]{10,}/g },

  // ─── Source-control + CI ───────────────────────────────────────────────
  // GitHub PATs and OAuth tokens. Five prefixes cover personal, OAuth,
  // user-to-server, server-to-server, and refresh tokens respectively.
  { name: "GitHub", re: /gh[poursa]_[A-Za-z0-9]{36,}/g },

  // ─── Cloud + payments ──────────────────────────────────────────────────
  // AWS access key ID — always starts with AKIA (root/IAM user keys) or
  // ASIA (temporary). 16 alphanumeric uppercase chars follow.
  { name: "AWS", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // Stripe API keys — live + test, public + secret.
  { name: "Stripe", re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },

  // ─── Generic high-confidence shapes ────────────────────────────────────
  // JSON Web Tokens — `eyJ`-prefixed base64url with two dots. Catches the
  // common case where an auth header is accidentally committed.
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // PEM-armoured private keys. Catches RSA, DSA, EC, OpenSSH, and the
  // generic "PRIVATE KEY" header used by PKCS#8. The regex matches the
  // armour line; the key body itself is multi-line.
  { name: "PrivateKey", re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED |)PRIVATE KEY-----/g },
];

// Names that, when matched anywhere on a line, suppress an OpenAI hit.
// Lets the more specific Anthropic regex win the line without the generic
// `sk-` matcher also flagging it. (Anthropic prefix starts with `sk-ant-`,
// which the OpenAI regex would otherwise also match.)
const OPENAI_SUPPRESSORS = ["sk-ant-"];

export function shouldSuppress(patternName, line) {
  if (patternName !== "OpenAI") return false;
  return OPENAI_SUPPRESSORS.some(s => line.includes(s));
}

export function maskMatch(s) {
  if (s.length <= 12) return s.slice(0, 4) + "…";
  return s.slice(0, 8) + "…" + s.slice(-4);
}
