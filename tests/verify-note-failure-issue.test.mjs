// tests/verify-note-failure-issue.test.mjs — a verification that could not run
// must not read as one that passed.
//
// verify-note returned `{verified:false, error}` with no `issues` array on any
// fetch failure, while the promotion gate in agents/inbox-organiser.md counts
// `sources[].issues[].severity === 'high'`. A fabricated PMID, an NCBI 429, or
// LL_OFFLINE therefore all yielded highSeverityIssues === 0 and the note was
// promoted to 3-permanent/ — the exact opposite of the gate's purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RESOLVER = fileURLToPath(
  new URL('../plugin/scripts/source-resolver.mjs', import.meta.url),
);

// The severity filter the shipped inbox-organiser gate snippet applies.
function highSeverityIssues(parsed) {
  return (parsed.sources || []).flatMap((s) => s.issues || []).filter((i) => i.severity === 'high')
    .length;
}

function verifyNoteOffline(body) {
  const dir = mkdtempSync(join(tmpdir(), 'll-verify-note-'));
  try {
    const notePath = join(dir, 'note.md');
    writeFileSync(notePath, body);
    const out = execFileSync(process.execPath, [RESOLVER, 'verify-note', notePath], {
      encoding: 'utf-8',
      env: { ...process.env, LL_OFFLINE: '1' },
    });
    return JSON.parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an unreachable citation is a high-severity issue, not a silent pass', () => {
  const parsed = verifyNoteOffline(
    ['---', 'tags: [x]', 'date: 2026-08-04', 'source: literature', '---', '# A claim', '', 'Smith et al. 2019 found the thing (PMID 12345678).'].join('\n'),
  );
  const src = parsed.sources[0];
  assert.equal(src.verified, false);
  assert.ok(Array.isArray(src.issues) && src.issues.length > 0, 'a failed check must carry issues');
  assert.equal(src.issues[0].severity, 'high');
  assert.equal(src.issues[0].type, 'verification_failed');
  assert.ok(highSeverityIssues(parsed) > 0, 'the promotion gate must see this and demote');
});

test('a bare link carries no citation claim, so it stays low and does not demote', () => {
  const parsed = verifyNoteOffline(
    ['---', 'tags: [x]', 'date: 2026-08-04', 'source: session', '---', '# A note', '', 'See [the docs](https://example.com/x) for detail.'].join('\n'),
  );
  const src = parsed.sources[0];
  assert.equal(src.verified, false);
  assert.equal(src.issues[0].severity, 'low');
  assert.equal(src.issues[0].type, 'unverifiable_source');
  assert.equal(
    highSeverityIssues(parsed),
    0,
    'every note containing a web link would otherwise be demoted',
  );
});
