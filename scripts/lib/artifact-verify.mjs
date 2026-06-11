// Verification helpers for release-artifact downloads (SHA256SUMS format:
// "<hex>  <filename>" or "<hex> *<filename>" per coreutils sha256sum).
// Scope: SHA256SUMS comes from the SAME GitHub release as the artifact, so
// this is an integrity check (corruption, truncation, single-object CDN swap)
// — not authenticity; a compromised release defeats it.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function parseSums(text) {
  const map = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([0-9a-f]{4,64})\s+\*?(\S+)\s*$/i);
    if (m) map[m[2]] = m[1].toLowerCase();
  }
  return map;
}

export function verifyArtifact(filePath, sumsText, artifactName) {
  const sums = parseSums(sumsText);
  const expected = sums[artifactName];
  if (!expected) throw new Error(`${artifactName} not listed in SHA256SUMS`);
  const actual = createHash('sha256').update(readFileSync(filePath)).digest('hex');
  if (actual !== expected) {
    throw new Error(`sha256 mismatch for ${artifactName}: expected ${expected}, got ${actual}`);
  }
  return true;
}

export function isAllowedRedirect(url) {
  return typeof url === 'string' && url.startsWith('https://');
}
