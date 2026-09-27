// Regression test for scripts/sweep-hook-replay.mjs.
// The script broke silently from v1.16.10 to v1.16.13 because it shelled out
// to hooks that had been merged into hooks/post-tool.js. The replay test at
// the bottom runs a real note through the dispatcher in a sandbox and checks
// the provenance record it leaves; the rest cover the argument/IO surface:
// help text, missing-file path, stdin path-list parsing, and the JSON summary
// shape.

import { test, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'plugin', 'scripts', 'sweep-hook-replay.mjs');

const sandboxRoots = [];
after(() => {
  for (const root of sandboxRoots) rmSync(root, { recursive: true, force: true });
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'll-sweep-'));
  sandboxRoots.push(root);
  const pluginData = join(root, 'plugin-data');
  mkdirSync(pluginData);
  return { root, pluginData };
}

function run(args, { sb = sandbox(), input, env = {} } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf-8',
    timeout: 20000,
    input,
    env: {
      PATH: process.env.PATH,
      HOME: sb.root,
      USERPROFILE: sb.root,
      CLAUDE_PLUGIN_DATA: sb.pluginData,
      ...env,
    },
  });
}

function readProvenance(pluginData) {
  const dir = join(pluginData, 'provenance');
  if (!existsSync(dir)) return [];
  const events = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (line.trim()) events.push(JSON.parse(line));
    }
  }
  return events;
}

test('--help exits 0 and mentions the post-tool dispatcher', () => {
  const result = run(['--help']);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /post-tool dispatcher|hooks\/post-tool\.js/);
  assert.match(result.stdout, /--stdin/);
});

test('no args exits 2 with usage on stderr', () => {
  const result = run([]);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /sweep-hook-replay/);
});

test('missing file produces a structured failure entry, not a crash', () => {
  const result = run(['/this/path/cannot/exist/note.md']);
  // Exit 1 because at least one file failed.
  assert.strictEqual(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.strictEqual(summary.processed, 1);
  assert.strictEqual(summary.ok, 0);
  assert.strictEqual(summary.failed, 1);
  assert.strictEqual(summary.failures.length, 1);
  assert.match(summary.failures[0].reason, /file not found/i);
});

test('--stdin parses newline-separated paths and reports per-path results', () => {
  // All paths missing: confirms stdin is read, paths are split correctly,
  // and each one yields a failure entry. Does not exercise the dispatcher.
  const stdin = '/nope/a.md\n/nope/b.md\n\n/nope/c.md\n';
  const result = run(['--stdin'], { input: stdin });
  assert.strictEqual(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.strictEqual(summary.processed, 3);
  assert.strictEqual(summary.failed, 3);
});

test('summary truncates failures list to 20 entries', () => {
  // 25 missing-file entries; failures list should cap at 20 even though
  // failed count reflects the true total.
  const paths = Array.from({ length: 25 }, (_, i) => `/nope/note-${i}.md`).join('\n');
  const result = run(['--stdin'], { input: paths });
  const summary = JSON.parse(result.stdout);
  assert.strictEqual(summary.processed, 25);
  assert.strictEqual(summary.failed, 25);
  assert.strictEqual(summary.failures.length, 20);
});

test('replays a vault note through post-tool.js and records its provenance', () => {
  const sb = sandbox();
  const vault = join(sb.root, 'vault');
  mkdirSync(join(vault, '0-inbox'), { recursive: true });
  const note = join(vault, '0-inbox', 'replayed.md');
  writeFileSync(note, '---\ntags: [test]\n---\nA note a subagent wrote.\n');

  const result = run([note], { sb, env: { VAULT_PATH: vault } });
  assert.strictEqual(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.strictEqual(summary.processed, 1);
  assert.strictEqual(summary.ok, 1);
  assert.strictEqual(summary.failed, 0);

  const events = readProvenance(sb.pluginData);
  const write = events.find((e) => e.action === 'vault-write');
  assert.ok(write, `no vault-write provenance event; got ${JSON.stringify(events)}`);
  assert.strictEqual(write.target, '0-inbox/replayed.md');
});
