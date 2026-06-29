// Tests for resolve-paths.mjs --sh — the eval-safe KEY='value' export mode that
// lets /reflect carry every run-invariant path from ONE spawn (S1 in the
// reflect-improvements plan) instead of re-resolving per field.
//
// The only thing that can go wrong here is quoting: a path with a single quote
// must not break the `eval "$(...)"`. We force a single-quote path through the
// real script (via VAULT_PATH) and round-trip it through `sh -c 'eval ...'` so
// the script's own shQuote is exercised, not a re-implementation of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const SCRIPT = new URL('../plugin/scripts/resolve-paths.mjs', import.meta.url).pathname;

test('--sh output is eval-safe and sets shell vars', () => {
  const shOut = execFileSync('node', [SCRIPT, '--sh'], { encoding: 'utf-8' });
  // every non-empty line is KEY='...'
  for (const line of shOut.split('\n').filter(Boolean)) {
    assert.match(line, /^[A-Z_]+='.*'$/, `not eval-safe: ${line}`);
  }
  // round-trip: eval it in a real shell, echo SESSION_ID back
  const back = execFileSync(
    'sh',
    ['-c', `eval "${shOut.replace(/"/g, '\\"')}"; printf '%s' "$SESSION_ID"`],
    {
      encoding: 'utf-8',
    },
  );
  const direct = execFileSync('node', [SCRIPT, 'SESSION_ID'], { encoding: 'utf-8' }).trim();
  assert.equal(back, direct, 'eval-set SESSION_ID matches the single-field resolve');
});

test("the script's own shQuote survives an apostrophe in a real path", () => {
  // Drive the REAL resolve-paths.mjs --sh with a single-quote VAULT (injected
  // via VAULT_PATH, which getVaultPath() reads), eval its output in a real
  // shell, and assert the value round-trips. This exercises the script's
  // shQuote `.replace(/'/g, ...)` branch — a regression there would break the
  // `eval "$(...--sh)"` that every reflect fence runs, mid-handshake. The
  // earlier version re-implemented the escaping inline and never invoked the
  // script's own, so deleting shQuote left it green.
  const VALUE = "/tmp/wei'rd vault";
  const shOut = execFileSync('node', [SCRIPT, '--sh'], {
    encoding: 'utf-8',
    env: { ...process.env, VAULT_PATH: VALUE },
  });
  const back = execFileSync(
    'sh',
    ['-c', `eval "${shOut.replace(/"/g, '\\"')}"; printf '%s' "$VAULT"`],
    {
      encoding: 'utf-8',
    },
  );
  assert.equal(
    back,
    VALUE,
    'apostrophe VAULT path must round-trip through the script shQuote + eval',
  );
});

test('--sh REFLECT_SCRATCH/SESSION_ID match the single-field resolver (mode agreement)', () => {
  // The two modes read the same `fields` object, so they must agree value-for-
  // value. Pin the two the marker handshake depends on: if --sh ever diverged
  // from single-field (which the hook mirrors), the skill and hook would land
  // on different marker paths.
  const shOut = execFileSync('node', [SCRIPT, '--sh'], { encoding: 'utf-8' });
  const parsed = Object.fromEntries(
    shOut
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const eq = line.indexOf('=');
        const key = line.slice(0, eq);
        const raw = line.slice(eq + 1).replace(/^'|'$/g, '');
        return [key, raw.replace(/'\\''/g, "'")];
      }),
  );
  for (const field of ['SESSION_ID', 'REFLECT_SCRATCH']) {
    const direct = execFileSync('node', [SCRIPT, field], { encoding: 'utf-8' }).trimEnd();
    assert.equal(parsed[field], direct, `--sh ${field} must equal the single-field resolve`);
  }
});
