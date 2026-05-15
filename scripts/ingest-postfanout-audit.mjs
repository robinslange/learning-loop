import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FOCUS_TO_FILE = {
  stack: 'STACK.md',
  arch: 'ARCH.md',
  conventions: 'CONVENTIONS.md',
  domain: 'DOMAIN.md',
};

const ALWAYS_EXPECTED = ['METADATA.json'];

export function auditPostFanout(vaultRoot, slug, successfulFocuses) {
  const dir = join(vaultRoot, '_ingested-repos', slug);
  if (!existsSync(dir)) {
    return { ok: false, missing: [`${slug}/ (directory absent)`], unexpected: [] };
  }
  const expected = new Set([
    ...successfulFocuses.map(f => FOCUS_TO_FILE[f]).filter(Boolean),
    ...ALWAYS_EXPECTED,
  ]);
  const present = new Set(readdirSync(dir));
  const missing = [...expected].filter(f => !present.has(f));
  const unexpected = [...present].filter(f => !expected.has(f));

  return {
    ok: missing.length === 0 && unexpected.length === 0,
    missing,
    unexpected,
  };
}
