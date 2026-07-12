#!/usr/bin/env node
// scripts/strip-reflect-sid.mjs : strip the transient `reflect_sid:` stamp from
// the frontmatter of each note listed on stdin. Replaces the /reflect Step 4.6.g
// python3 per-note while-loop (one cold interpreter spawn per note) with a single
// node pass.
//
// Frontmatter-SCOPED (QW7): only `reflect_sid:` lines inside the leading
// `---\n...\n---` block are removed. A note BODY line that happens to start with
// `reflect_sid:` (plausible in a vault documenting this plugin) is left intact —
// the old whole-file `re.sub(count=1)` could strip it by mistake.
//
// Idempotent and write-only-if-changed: notes without the stamp, and notes with
// no frontmatter fence, are left byte-for-byte untouched. Missing files are
// skipped silently. Reads newline-separated absolute paths from stdin (--stdin).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { splitRawFrontmatter } from './lib/markdown-parse.mjs';

function readStdinPaths() {
  const raw = readFileSync(0, 'utf-8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

// Remove `reflect_sid:` lines from the frontmatter block only. Returns the new
// text, or the original (same reference) when nothing changed. Uses the lib's
// lossless split so everything outside the removed lines survives
// byte-for-byte, CRLF vaults included.
export function stripReflectSid(text) {
  const parts = splitRawFrontmatter(text);
  if (!parts) return text; // no frontmatter fence -> never touch the body
  const strippedFm = parts.fm
    .split(/\r?\n/)
    .filter((line) => !/^reflect_sid:/.test(line))
    .join(parts.nl);
  if (strippedFm === parts.fm) return text;
  return '---' + parts.nl + strippedFm + parts.nl + '---' + parts.trailing + parts.body;
}

function main() {
  const paths = process.argv.includes('--stdin') ? readStdinPaths() : process.argv.slice(2);
  let stripped = 0;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    let text;
    try {
      text = readFileSync(p, 'utf-8');
    } catch {
      continue;
    }
    const next = stripReflectSid(text);
    if (next !== text) {
      writeFileSync(p, next);
      stripped++;
    }
  }
  process.stdout.write(JSON.stringify({ stripped }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
