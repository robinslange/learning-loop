import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA_PATHS } from '../plugin/scripts/lib/paths.mjs';

const REPORT = join(import.meta.dirname, '..', 'plugin', 'scripts', 'cache-health-report.mjs');

function report(args, seed) {
  const root = mkdtempSync(join(tmpdir(), 'll-cache-report-'));
  try {
    const home = join(root, 'home');
    const data = join(root, 'data');
    mkdirSync(home);
    const dir = DATA_PATHS.retrieval(data);
    mkdirSync(dir, { recursive: true });
    seed(dir);
    return spawnSync('node', [REPORT, ...args], {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: data },
      encoding: 'utf-8',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const row = JSON.stringify({ session_id: 's1', turn_hit_rate: 0.9, total_cost_usd: 0.1 });

test('no cache-health shards reads as no logs, not as an empty filter', () => {
  const r = report([], () => {});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No cache-health logs found\./);
});

test('a month with no shard reads as no logs', () => {
  const r = report(['--month', '2025-01'], (dir) =>
    writeFileSync(join(dir, 'cache-health-2026-09.jsonl'), row + '\n'),
  );
  assert.match(r.stdout, /No cache-health logs found\./);
});

test('a session filter that matches nothing reads as no matching rows', () => {
  const r = report(['--session', 'other'], (dir) =>
    writeFileSync(join(dir, 'cache-health-2026-09.jsonl'), row + '\n'),
  );
  assert.match(r.stdout, /No matching rows\./);
});
