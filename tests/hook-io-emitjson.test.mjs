import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// emitJson writes to process.stdout; exercise it in a child process so we
// capture exactly what a hook would emit.
function runEmit(objLiteral) {
  const src = `
    import { emitJson } from '${pathToFileURL(join(root, 'hooks/lib/io.mjs')).href}';
    emitJson(${objLiteral});
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
    encoding: 'utf8',
  });
  return { stdout: res.stdout, stderr: res.stderr };
}

test('oversized additionalContext is trimmed inside the field — output stays valid JSON', () => {
  const { stdout } = runEmit(`{
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'x'.repeat(100_000),
    },
  }`);
  const parsed = JSON.parse(stdout); // throws on current code: byte-sliced envelope
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(parsed.hookSpecificOutput.additionalContext.endsWith('…[truncated]'));
  assert.ok(Buffer.byteLength(stdout, 'utf8') <= 8192);
});

test('small payloads pass through byte-identical', () => {
  const { stdout } = runEmit(`{ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hello' } }`);
  assert.deepEqual(JSON.parse(stdout), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hello' },
  });
});

test('oversized payload with no trimmable field emits nothing on stdout + logs the drop', () => {
  const { stdout, stderr } = runEmit(`{ blob: 'y'.repeat(100_000) }`);
  assert.equal(stdout, '');
  assert.match(stderr, /emitJson/); // logError writes JSON lines to stderr (scripts/lib/log.mjs)
});

test('multibyte content never splits a code point', () => {
  // A well-formed string can never land the binary search mid-pair: a lone
  // high surrogate at a mid-pair boundary serializes as a 6-byte \uXXXX
  // escape while completing the pair costs only 4 UTF-8 bytes, so the
  // largest fitting prefix always pair-completes. Plant a lone high
  // surrogate exactly at the landing boundary (keep=8089 for this shape) so
  // the surrogate guard actually fires.
  const { stdout } = runEmit(
    `{
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: '🧠🧠' + 'x'.repeat(8084) + '\\ud83e' + '🧠'.repeat(2000),
    },
  }`,
  );
  const parsed = JSON.parse(stdout);
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes('🧠'));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(parsed.hookSpecificOutput.additionalContext));
  assert.ok(Buffer.byteLength(stdout, 'utf8') <= 8192);
});
