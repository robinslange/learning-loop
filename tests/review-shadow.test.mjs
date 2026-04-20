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
    for (let i = 0; i < 90; i++) {
      entries.push(JSON.stringify({
        ts: now.toISOString(), session_id: 's1', prompt: `non-matching question number ${i}`,
        gate: { passed: false, vault_top_score: 0.1, episodic_top_score: 0.05, threshold: 0.35 },
        backends: { vault: { latency_ms: 120, hits: 0 }, episodic: { latency_ms: 800, hits: 0, raced_out: false } },
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

  it('reports READY verdict when enough healthy passes and good pass rate', () => {
    const out = execFileSync('node', [SCRIPT], {
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.match(out, /Backend health/);
    assert.match(out, /Healthy pass rate:\s+30 \/ 120/);
    assert.match(out, /READY FOR REVIEW/);
    assert.match(out, /Fast-path skips: 10/);
  });

  it('fires INFRASTRUCTURE verdict when backends are unhealthy', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'review-shadow-test-infra-'));
    const subdir = join(dir2, 'retrieval');
    mkdirSync(subdir, { recursive: true });
    const logPath = join(subdir, `shadow-injection-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}.jsonl`);
    const entries = [];
    for (let i = 0; i < 100; i++) {
      entries.push(JSON.stringify({
        ts: new Date().toISOString(), session_id: 's1', prompt: `question ${i}`,
        gate: { passed: false, vault_top_score: 0, episodic_top_score: 0 },
        backends: {
          vault: { latency_ms: 2, hits: 0, error: 'spawn ll-search ENOENT', raced_out: false },
          episodic: { latency_ms: 0, hits: 0, error: 'spawn episodic-memory ENOENT', raced_out: false },
        },
      }));
    }
    writeFileSync(logPath, entries.join('\n') + '\n');
    const out = execFileSync('node', [SCRIPT], {
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dir2 },
    });
    assert.match(out, /INFRASTRUCTURE/);
    assert.match(out, /spawn ll-search ENOENT/);
    rmSync(dir2, { recursive: true, force: true });
  });
});
