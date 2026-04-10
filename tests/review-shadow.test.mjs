import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'review-shadow.mjs');

describe('review-shadow', () => {
  let dataDir;
  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'review-shadow-test-'));
    const dir = join(dataDir, 'retrieval');
    mkdirSync(dir, { recursive: true });
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const logPath = join(dir, `shadow-injection-${month}.jsonl`);
    const entries = [];
    for (let i = 0; i < 30; i++) {
      entries.push(JSON.stringify({
        ts: now.toISOString(), session_id: 's1', prompt: `question ${i}`,
        gate: { passed: true, vault_top_score: 0.7 + i * 0.01 },
        backends: { vault: { latency_ms: 100 + i, hits: 5 }, episodic: { latency_ms: 900, raced_out: false } },
        payload: { tokens_estimated: 450, vault_notes: 5 },
        would_inject: `injection ${i}`,
      }));
    }
    for (let i = 0; i < 10; i++) {
      entries.push(JSON.stringify({
        ts: now.toISOString(), session_id: 's1', prompt: 'ok',
        gate: { passed: false, fast_path_skip: true },
      }));
    }
    writeFileSync(logPath, entries.join('\n') + '\n');
  });
  after(() => rmSync(dataDir, { recursive: true, force: true }));

  it('prints stats and reports not-ready when n < 50', () => {
    const out = execFileSync('node', [SCRIPT], {
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.match(out, /gate pass rate/i);
    assert.match(out, /30 passed-gate entries/);
    assert.match(out, /20 more entries needed/);
    assert.match(out, /fast-path/i);
  });
});
