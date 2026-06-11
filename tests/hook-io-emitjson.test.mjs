import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { HookConfig } from '../scripts/lib/hook-config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX = HookConfig.HOOK_STDOUT_MAX_BYTES;

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
  assert.ok(Buffer.byteLength(stdout, 'utf8') <= MAX);
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
  // A well-formed string can never land the binary search mid-pair (a lone
  // high surrogate serializes as a 6-byte escape while completing the pair
  // costs 4 UTF-8 bytes), so plant a LONE high surrogate exactly at the
  // landing boundary to force the surrogate guard to fire.
  // 108 is empirically derived: with MAX=8192 the binary-search best lands at
  // keep=8089 (8088 after the surrogate trim), giving pad = MAX - 108 = 8084.
  // Structural overhead (envelope + '…[truncated]' + two leading emoji) is 100
  // bytes; the remaining 8 come from the planted lone surrogate serializing as
  // a 6-byte \uXXXX escape, which shifts the landing point past a pure
  // byte-budget estimate. The pad tracks MAX so the surrogate guard keeps
  // firing if the constant changes.
  const src = `
    import { emitJson } from '${pathToFileURL(join(root, 'hooks/lib/io.mjs')).href}';
    import { HookConfig } from '${pathToFileURL(join(root, 'scripts/lib/hook-config.mjs')).href}';
    const pad = HookConfig.HOOK_STDOUT_MAX_BYTES - 108;
    emitJson({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '🧠🧠' + 'x'.repeat(pad) + '\\ud83e' + '🧠'.repeat(2000),
      },
    });
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' });
  const parsed = JSON.parse(res.stdout);
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes('🧠'));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(parsed.hookSpecificOutput.additionalContext));
  assert.ok(Buffer.byteLength(res.stdout, 'utf8') <= MAX);
});
