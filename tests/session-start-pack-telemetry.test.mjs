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
import { emitJson } from '../plugin/hooks/lib/io.mjs';
import { join } from 'node:path';
import {
  shippedIntentionContexts,
  recordIntentionsShipped,
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
  // session.mjs:44-46 documents this seam precisely so a test cannot read or
  // delete the machine's live learning-loop-session-id. Without it getSessionId
  // resolves against whatever session happens to be running on the developer's
  // box, so the test's result depends on the machine it runs on.
  const prevTmp = process.env.LL_SESSION_TMP_DIR;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  process.env.LL_SESSION_TMP_DIR = join(sb, 'session-tmp');
  mkdirSync(process.env.LL_SESSION_TMP_DIR, { recursive: true });
  try {
    const ctx = {
      pluginDir: join(process.cwd(), 'plugin'),
      pluginData,
      vaultRoot,
      projectDir: null,
      memoryDir: join(sb, 'memdir'),
      updateCacheFile: null,
      depsAllSatisfied: true,
      depsMissing: '',
      context: '',
    };
    await run(ctx);
    // run() stashes the block; session-start.js writes the row after emitJson,
    // against the text emitJson reports it actually wrote. Nothing is trimmed
    // here, so the emitted text is the assembled context.
    recordIntentionsShipped(ctx, ctx.context, pluginData);
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
    if (prevTmp === undefined) delete process.env.LL_SESSION_TMP_DIR;
    else process.env.LL_SESSION_TMP_DIR = prevTmp;
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
  const prevTmp = process.env.LL_SESSION_TMP_DIR;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  process.env.CLAUDE_CODE_SESSION_ID = 'env-side-id';
  // Isolate the marker seam too: the env var above is only the first candidate
  // getSessionId tries, so without this the fallbacks reach the live machine.
  process.env.LL_SESSION_TMP_DIR = join(sb, 'session-tmp');
  mkdirSync(process.env.LL_SESSION_TMP_DIR, { recursive: true });
  try {
    const ctx = {
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
    };
    await run(ctx);
    recordIntentionsShipped(ctx, ctx.context, pluginData);
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
    if (prevTmp === undefined) delete process.env.LL_SESSION_TMP_DIR;
    else process.env.LL_SESSION_TMP_DIR = prevTmp;
    rmSync(sb, { recursive: true, force: true });
  }
});

test('the record counts only contexts that survived emitJson, not the assembled list', async () => {
  // The regression this whole feature exists to prevent, and which the row
  // still had because it read the wrong text. capSection is the FIRST
  // truncation and the assembler can see it. emitJson's backstop trim is the
  // second, fires only when the whole payload is oversized, and takes this
  // block first by design. A row built before the emit records impressions the
  // model never received: measured on a live install at 9,538 bytes assembled
  // against 8,054 emitted, 59 contexts recorded, 21 of them absent.
  //
  // Composed against the real emitJson with stdout captured, because the bug
  // lives in the seam between the two and neither half shows it alone.
  const sb = mkdtempSync(join(realpathSync(tmpdir()), 'll-pack-trim-'));
  const pluginData = join(sb, 'plugin-data');
  const vaultRoot = join(sb, 'vault');
  mkdirSync(join(pluginData, 'session-start-cache'), { recursive: true });
  mkdirSync(join(vaultRoot, '0-inbox'), { recursive: true });
  // Enough contexts, with long names, that the assembled payload overflows the
  // 8 KiB stdout cap and the backstop has to cut into this block.
  writeFileSync(
    join(pluginData, 'session-start-cache', 'intentions.json'),
    JSON.stringify(
      Array.from({ length: 120 }, (_, i) => ({
        context: `context number ${i} with a deliberately long name to fill the payload`,
        count: i + 2,
      })),
    ),
  );

  const prev = process.env.CLAUDE_PLUGIN_DATA;
  const prevTmp = process.env.LL_SESSION_TMP_DIR;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  process.env.LL_SESSION_TMP_DIR = join(sb, 'session-tmp');
  mkdirSync(process.env.LL_SESSION_TMP_DIR, { recursive: true });
  const realWrite = process.stdout.write.bind(process.stdout);
  let captured = '';
  try {
    const ctx = {
      pluginDir: join(process.cwd(), 'plugin'),
      pluginData,
      vaultRoot,
      projectDir: null,
      memoryDir: join(sb, 'memdir'),
      updateCacheFile: null,
      depsAllSatisfied: true,
      depsMissing: '',
      // The backstop trims a PREFIX, so it eats the tail, and this block is
      // ordered last for exactly that reason. capSection already holds the
      // block itself under 3 KiB, so it can never overflow an 8 KiB payload
      // alone: on a live install it is the sections BEFORE it that use the
      // budget up (7,825 of 8,192 bytes, 367 to spare). This filler stands in
      // for those, which is what puts the block in the trim's path.
      context: `## Earlier sections\n${'filler line that stands in for the memory index\n'.repeat(130)}`,
      sessionId: 'sid-trim',
    };
    await run(ctx);

    process.stdout.write = (chunk) => {
      captured += chunk;
      return true;
    };
    const emitted = emitJson({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx.context },
    });
    process.stdout.write = realWrite;

    assert.ok(
      Buffer.byteLength(ctx.context, 'utf8') > Buffer.byteLength(emitted ?? '', 'utf8'),
      'the fixture must actually overflow, or this test proves nothing',
    );
    assert.ok(captured.length > 0 && captured.length <= 8192, 'the payload was written and capped');

    const meta = recordIntentionsShipped(ctx, emitted, pluginData);
    const assembledContexts = shippedIntentionContexts(ctx.intentionsBlock);
    assert.ok(
      meta.contexts.length < assembledContexts.length,
      'the trim dropped contexts, so the row must record fewer than were assembled',
    );
    const sent = JSON.parse(captured).hookSpecificOutput.additionalContext;
    for (const c of meta.contexts) {
      assert.ok(sent.includes(c), `recorded context ${JSON.stringify(c)} must be in what was sent`);
    }
  } finally {
    process.stdout.write = realWrite;
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    if (prevTmp === undefined) delete process.env.LL_SESSION_TMP_DIR;
    else process.env.LL_SESSION_TMP_DIR = prevTmp;
    rmSync(sb, { recursive: true, force: true });
  }
});
