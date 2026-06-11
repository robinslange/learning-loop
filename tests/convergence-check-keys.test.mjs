import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { hasBinary } from '../plugin/scripts/lib/binary.mjs';

const SCRIPT = new URL('../plugin/scripts/convergence-check.mjs', import.meta.url).pathname;

function runCheck(...args) {
  return execFileSync('node', [SCRIPT, ...args], { encoding: 'utf-8' });
}

function runCheckStdin(args, stdin) {
  return execFileSync('node', [SCRIPT, ...args], { encoding: 'utf-8', input: stdin });
}

test('convergence-check init emits snake_case keys', () => {
  const session = `t-${randomBytes(4).toString('hex')}`;
  try {
    const out = JSON.parse(runCheck('init', session));
    assert.equal(out.ok, true);
    assert.equal(out.session_id, session);
    assert.equal(out.sessionId, undefined, 'sessionId camelCase should be gone');
  } finally {
    try {
      runCheck('reset', session);
    } catch {}
  }
});

test(
  'convergence-check accepts result text on stdin via "-"',
  // `check` invokes embed() which needs the native ll-search binary. Skip on
  // environments without it (e.g. CI without the build-native job's artifact).
  { skip: hasBinary() ? false : 'll-search binary not available' },
  () => {
    const session = `t-${randomBytes(4).toString('hex')}`;
    try {
      runCheck('init', session);
      const out = JSON.parse(
        runCheckStdin(
          ['check', session, 'phosphatidylserine cortisol', '-'],
          'Phosphatidylserine supplementation blunts cortisol after acute stress in healthy adults. Hellhammer 2004 used 400mg/day for three weeks.',
        ),
      );
      assert.equal(out.stop, false);
      assert.equal(out.query_number, 1);
      assert.ok(out.signals);
      assert.equal(typeof out.signals.novelty_rate, 'number');
    } finally {
      try {
        runCheck('reset', session);
      } catch {}
    }
  },
);

test('convergence-check status emits snake_case keys', () => {
  const session = `t-${randomBytes(4).toString('hex')}`;
  try {
    runCheck('init', session);
    const status = JSON.parse(runCheck('status', session));
    for (const camel of [
      'sessionId',
      'queryCount',
      'totalSentences',
      'totalEntities',
      'totalCitations',
      'noveltyRates',
      'runningAvgRate',
    ]) {
      assert.equal(status[camel], undefined, `camelCase ${camel} should not appear`);
    }
    assert.ok('session_id' in status);
    assert.ok('query_count' in status);
    assert.ok('total_sentences' in status);
    assert.ok('total_entities' in status);
    assert.ok('total_citations' in status);
    assert.ok('novelty_rates' in status);
    assert.ok('running_avg_rate' in status);
  } finally {
    try {
      runCheck('reset', session);
    } catch {}
  }
});
