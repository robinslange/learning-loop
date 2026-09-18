// tests/cache-health-statusline.test.mjs
// The cache-health statusline plugin keeps per-session state in tmpdir and
// dedupes repeated statusline renders of the same turn. Two defects it had:
// session files accumulated there forever, and the dedupe marker was a single
// global file, so two live sessions alternating renders each saw the other's
// marker and counted every render as a new turn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PLUGIN = join(
  import.meta.dirname,
  '..',
  'plugin',
  'plugins',
  'omc-cache-health',
  'plugin.js',
);

function payload(sessionId, { read, create, uncached }) {
  return {
    session_id: sessionId,
    context_window: {
      current_usage: {
        cache_read_input_tokens: read,
        cache_creation_input_tokens: create,
        input_tokens: uncached,
      },
    },
  };
}

async function freshModule(stateDir) {
  process.env.LL_CACHE_HEALTH_STATE_DIR = stateDir;
  // cache-busted import so module-level state dir resolution re-runs
  return import(pathToFileURL(PLUGIN).href + `?t=${stateDir}`);
}

test('two concurrent sessions do not consume each others turn markers', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'll-cachehealth-'));
  t.after(() => {
    delete process.env.LL_CACHE_HEALTH_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
  const { render } = await freshModule(dir);

  const a = payload('sess-a', { read: 100, create: 10, uncached: 5 });
  const b = payload('sess-b', { read: 200, create: 20, uncached: 5 });

  // Each session renders its own turn once, then the statusline re-fires for
  // both (permission prompt, vim mode) with identical usage. Only the first
  // render of each turn may advance that session's turn counter.
  render(a, {});
  render(b, {});
  render(a, {});
  render(b, {});

  const stateFile = readdirSync(dir).find((f) => f.startsWith('omc-cache-health-session-sess-a'));
  const stateA = JSON.parse(readFileSync(join(dir, stateFile), 'utf8'));
  assert.equal(stateA.turns, 1, 'session a saw one real turn, not one per render');
});
