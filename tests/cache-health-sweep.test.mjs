// tests/cache-health-sweep.test.mjs
// The cache-health statusline plugin keeps per-session state in tmpdir and
// dedupes repeated statusline renders of the same turn. Two defects it had:
// session files accumulated there forever, and the dedupe marker was a single
// global file, so two live sessions alternating renders each saw the other's
// marker and counted every render as a new turn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  utimesSync,
} from 'node:fs';
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
  // The plugin resolves its cache-health JSONL sink from CLAUDE_PLUGIN_DATA
  // (falling back to the real install named in ~/.claude/plugins/data/
  // .ll-data-path), independently of the state dir. Without this every local
  // test run appended fixture records to the real corpus.
  process.env.CLAUDE_PLUGIN_DATA = stateDir;
  // cache-busted import so module-level state dir resolution re-runs
  return import(pathToFileURL(PLUGIN).href + `?t=${stateDir}`);
}

// Lives in its own file on purpose. The plugin fixes its state directory at
// import (`const SESSION_DIR = process.env... || tmpdir()`), and the sweep
// deletes stale files across that whole directory on every new turn. Two
// tests in one process therefore share one directory whatever setup they do,
// and one test's renders reap the other's fixtures: this pair flaked exactly
// that way, passing alone and failing under the full suite. node --test gives
// each FILE its own process, which is the isolation this needs.

test('stale session state files are swept, the live one is kept', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'll-cachehealth-'));
  t.after(() => {
    delete process.env.LL_CACHE_HEALTH_STATE_DIR;
    delete process.env.CLAUDE_PLUGIN_DATA;
    rmSync(dir, { recursive: true, force: true });
  });

  const stale = join(dir, 'omc-cache-health-session-ancient.json');
  writeFileSync(stale, JSON.stringify({ turns: 3, window: [] }), 'utf8');
  const old = Date.now() / 1000 - 30 * 86400;
  utimesSync(stale, old, old);

  const { render } = await freshModule(dir);
  render(payload('sess-new', { read: 100, create: 10, uncached: 5 }), {});

  assert.ok(!existsSync(stale), 'a month-old session file should be swept');
  assert.ok(
    readdirSync(dir).some((f) => f.includes('sess-new')),
    'the live session file stays',
  );
});
