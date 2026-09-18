// The SessionStart pack has never had a surfaced->used join. The JIT path got
// one by first logging what it injected (injected_paths), which is what made
// the reranker refutable. This is the same first step for the pack: record
// what the intentions block actually SHIPPED, which is not what it assembled,
// because capSection truncates the rendered list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  shippedIntentionContexts,
  run,
} from '../plugin/hooks/session-start/context-assembly.mjs';

test('shippedIntentionContexts reads the contexts back off the rendered block', () => {
  const text = ['- web development (141 notes)', '- learning-loop (91 notes)'].join('\n');
  assert.deepEqual(shippedIntentionContexts(text), ['web development', 'learning-loop']);
});

test('shippedIntentionContexts excludes contexts the cap dropped', () => {
  // capSection keeps whole lines and appends a pointer. A context that was
  // assembled but cut must not be recorded as shipped, or the join counts an
  // impression the session never saw.
  const text = [
    '- web development (141 notes)',
    '[truncated — run `ll-search intentions` for the full list]',
  ].join('\n');
  assert.deepEqual(shippedIntentionContexts(text), ['web development']);
});

test('shippedIntentionContexts handles a context name containing parentheses', () => {
  const text = '- thalen (cognitive testing) (108 notes)';
  assert.deepEqual(shippedIntentionContexts(text), ['thalen (cognitive testing)']);
});

test('shippedIntentionContexts returns empty for an absent block', () => {
  assert.deepEqual(shippedIntentionContexts(''), []);
  assert.deepEqual(shippedIntentionContexts(null), []);
});

test('the intentions block emits a session-start-pack record of what it shipped', async () => {
  const sb = mkdtempSync(join(realpathSync(tmpdir()), 'll-pack-telemetry-'));
  const pluginData = join(sb, 'plugin-data');
  const vaultRoot = join(sb, 'vault');
  mkdirSync(join(pluginData, 'session-start-cache'), { recursive: true });
  mkdirSync(join(vaultRoot, '0-inbox'), { recursive: true });
  writeFileSync(
    join(pluginData, 'session-start-cache', 'intentions.json'),
    JSON.stringify([
      { context: 'web development', count: 141 },
      { context: 'learning-loop', count: 91 },
      { context: 'a singleton', count: 1 },
    ]),
  );

  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    await run({
      pluginDir: join(process.cwd(), 'plugin'),
      pluginData,
      vaultRoot,
      projectDir: null,
      memoryDir: join(sb, 'memdir'),
      updateCacheFile: null,
      depsAllSatisfied: true,
      depsMissing: '',
      context: '',
    });
    const dir = join(pluginData, 'retrieval');
    const file = readdirSync(dir).find((f) => f.startsWith('session-start-pack-'));
    assert.ok(file, 'a session-start-pack log was written');
    const rows = readFileSync(join(dir, file), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const rec = rows.find((r) => r.command === 'intentions');
    assert.ok(rec, 'an intentions record was emitted');
    // singletons are filtered before rendering, so they were never shipped
    assert.deepEqual(rec.contexts, ['web development', 'learning-loop']);
    assert.equal(rec.assembled_count, 2);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    rmSync(sb, { recursive: true, force: true });
  }
});

test('the record carries the canonical session id, not the env/marker resolution', async () => {
  // writeRetrieval stamps getSessionId(). vault-snapshot runs first and resolves
  // the canonical id (stdin payload preferred) onto ctx.sessionId, and the
  // used-side events key on that. When the two resolutions disagree the row is
  // unjoinable, which costs the whole row its purpose — so make them disagree.
  const sb = mkdtempSync(join(realpathSync(tmpdir()), 'll-pack-sid-'));
  const pluginData = join(sb, 'plugin-data');
  const vaultRoot = join(sb, 'vault');
  mkdirSync(join(pluginData, 'session-start-cache'), { recursive: true });
  mkdirSync(join(vaultRoot, '0-inbox'), { recursive: true });
  writeFileSync(
    join(pluginData, 'session-start-cache', 'intentions.json'),
    JSON.stringify([
      { context: 'web development', count: 141 },
      { context: 'learning-loop', count: 91 },
    ]),
  );

  const prevData = process.env.CLAUDE_PLUGIN_DATA;
  const prevSid = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  process.env.CLAUDE_CODE_SESSION_ID = 'env-side-id';
  try {
    await run({
      pluginDir: join(process.cwd(), 'plugin'),
      pluginData,
      vaultRoot,
      projectDir: null,
      memoryDir: join(sb, 'memdir'),
      updateCacheFile: null,
      depsAllSatisfied: true,
      depsMissing: '',
      context: '',
      sessionId: 'payload-canonical-id',
    });
    const dir = join(pluginData, 'retrieval');
    const file = readdirSync(dir).find((f) => f.startsWith('session-start-pack-'));
    const rec = readFileSync(join(dir, file), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((r) => r.command === 'intentions');
    assert.equal(rec.session_id, 'payload-canonical-id');
    assert.notEqual(rec.session_id, 'env-side-id');
  } finally {
    if (prevData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevData;
    if (prevSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prevSid;
    rmSync(sb, { recursive: true, force: true });
  }
});
