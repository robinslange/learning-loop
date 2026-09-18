// Tests for the contradiction-cycles doctor check (scripts/health-check.mjs)
// and its edges-cli surface. A contradiction cycle is knowledge state, not a
// dependency problem: the check reports it at severity warn and
// formatMissingDeps must not list it as a missing dependency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkContradictionCycles, formatMissingDeps } from '../plugin/scripts/health-check.mjs';
import { openEdgeDb, addEdge, saveDb } from '../plugin/scripts/lib/edges.mjs';

const CLI = fileURLToPath(new URL('../plugin/scripts/edges-cli.mjs', import.meta.url));

test('ok when there is no edges index to scan', () => {
  const c = checkContradictionCycles({ dbExists: false, cycles: null });
  assert.equal(c.id, 'contradiction-cycles');
  assert.equal(c.status, 'ok');
  assert.match(c.detail, /no edges index/);
});

test('warn-severity fail when the db exists but could not be read', () => {
  const c = checkContradictionCycles({ dbExists: true, cycles: null });
  assert.equal(c.status, 'fail');
  assert.equal(c.severity, 'warn');
  assert.match(c.detail, /unreadable/);
});

test('ok when the graph holds no contradiction cycles', () => {
  const c = checkContradictionCycles({ dbExists: true, cycles: [] });
  assert.equal(c.status, 'ok');
  assert.match(c.detail, /no contradiction cycles/);
});

test('warn-severity fail listing the cycle when one exists', () => {
  const cycles = [{ nodes: ['a.md', 'b.md'], contradictions: [] }];
  const c = checkContradictionCycles({ dbExists: true, cycles });
  assert.equal(c.status, 'fail');
  assert.equal(c.severity, 'warn');
  assert.match(c.detail, /1 contradiction cycle\(s\): a\.md -> b\.md -> a\.md/);
  assert.match(c.fix, /gaps/);
});

test('caps the listing at three cycles and counts the rest', () => {
  const cycles = Array.from({ length: 5 }, (_, i) => ({
    nodes: [`x${i}.md`, `y${i}.md`],
    contradictions: [],
  }));
  const c = checkContradictionCycles({ dbExists: true, cycles });
  assert.match(c.detail, /5 contradiction cycle\(s\)/);
  assert.match(c.detail, /\(\+2 more\)/);
});

test('formatMissingDeps does not list contradiction cycles as a missing dependency', () => {
  const result = {
    checks: [checkContradictionCycles({ dbExists: true, cycles: [{ nodes: ['a.md', 'b.md'] }] })],
  };
  assert.equal(formatMissingDeps(result), '');
});

test('edges-cli cycles reports a contradiction cycle from a real db', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-cycles-cli-'));
  try {
    const dbPath = join(dir, 'edges.db');
    const db = await openEdgeDb(dbPath);
    addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'supports' });
    addEdge(db, { fromPath: 'b.md', toPath: 'a.md', edgeType: 'challenges_rebuttal' });
    // A comention edge must not create cycles on its own.
    addEdge(db, {
      fromPath: 'a.md',
      toPath: 'c.md',
      edgeType: 'associative',
      confidence: 'low',
      sourceGraph: 'comention',
    });
    saveDb(db, dbPath);
    db.close();

    const child = spawnSync(process.execPath, [CLI, 'cycles'], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
    });
    assert.equal(child.status, 0, child.stderr);
    const parsed = JSON.parse(child.stdout);
    assert.equal(parsed.count, 1);
    assert.deepEqual(parsed.cycles[0].nodes.slice().sort(), ['a.md', 'b.md']);
    assert.equal(parsed.cycles[0].contradictions.length, 1);
    assert.equal(parsed.cycles[0].contradictions[0].type, 'challenges_rebuttal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
