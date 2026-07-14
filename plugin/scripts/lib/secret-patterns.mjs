// scripts/lib/secret-patterns.mjs : single source of truth for credential-shaped
// regexes, shared by the three scrubbers (inject.mjs, redact-scan.mjs,
// harvest-scrub.mjs). Each consumer keeps its own semantics on top:
//   - inject.mjs        replaces matches with [REDACTED] before context injection
//   - redact-scan.mjs   reports matches by kind (tuned for low false positives)
//   - harvest-scrub.mjs hard-blocks candidate content that matches (fail closed)
// These 10 patterns are unanchored by design (inject.mjs's original shape) so a
// hard-block or redaction net stays wide. redact-scan.mjs intentionally does NOT
// reuse these regex bodies verbatim — it needs \b-anchored, narrower patterns to
// avoid flagging ordinary hyphenated prose as a false positive; it builds its own
// PATTERNS array from this module's `kind` names to keep the two lists in sync.
export const SECRET_PATTERNS = [
  { kind: 'aws-key', re: /AKIA[0-9A-Z]{16}/g },
  { kind: 'github-pat', re: /gh[po]_[A-Za-z0-9]{36,}/g },
  { kind: 'anthropic-key', re: /sk-ant-api[A-Za-z0-9_-]{20,}/g },
  { kind: 'stripe-key', re: /sk_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { kind: 'generic-sk-key', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'cloudflare-pat', re: /cfpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'bearer-token', re: /Bearer\s+[A-Za-z0-9._\-\/+=]{20,}/g },
  { kind: 'slack-token', re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    kind: 'pem-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
];

export const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
