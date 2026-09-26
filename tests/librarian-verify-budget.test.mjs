// tests/librarian-verify-budget.test.mjs — buildVerifyBudget()'s Solenoid store choice
// for the verify CLI's GLM calls. Stubs only globalThis.fetch (the transport the
// vendored Solenoid SDK calls) and HOME (so os.homedir() resolves under a temp
// dir), never a Solenoid module — this exercises the real solenoid()/spend()
// code path. Every test points HOME and/or pluginData at a temp dir first, so
// this can never read or write the developer's real ~/.cache/solenoid.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { buildVerifyBudget } from '../plugin/scripts/librarian/verify.mjs';
import { budgetScopeSegment } from '../plugin/scripts/lib/fetch-budget.mjs';

let origFetch;
let origKey;
let origHome;
let realHomeCache;
let realHomeCacheBefore;
let sandbox;

function snapshot(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

beforeEach(() => {
  origFetch = globalThis.fetch;
  origKey = process.env.SOLENOID_KEY;
  origHome = process.env.HOME;
  // Computed before any test overrides HOME, so it names the developer's real
  // cache file regardless of what a test points HOME at afterward. Robin's
  // real learning-loop usage may have already created this file, so the
  // safety check below is "unchanged", never "absent".
  realHomeCache = join(homedir(), '.cache', 'solenoid', 'outage.json');
  realHomeCacheBefore = snapshot(realHomeCache);
  sandbox = mkdtempSync(join(tmpdir(), 'll-verify-budget-'));
});

afterEach(() => {
  globalThis.fetch = origFetch;
  if (origKey === undefined) delete process.env.SOLENOID_KEY;
  else process.env.SOLENOID_KEY = origKey;
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  assert.equal(
    snapshot(realHomeCache),
    realHomeCacheBefore,
    'must never read-modify-write the real ~/.cache/solenoid/outage.json',
  );
  rmSync(sandbox, { recursive: true, force: true });
});

function uniqueSessionId() {
  return `verify-budget-test-${randomUUID()}`;
}

describe('buildVerifyBudget — no-op cases', () => {
  it('returns undefined when SOLENOID_KEY is unset', () => {
    delete process.env.SOLENOID_KEY;
    assert.equal(buildVerifyBudget(uniqueSessionId(), sandbox), undefined);
  });

  it('returns undefined when the session id cannot form a scope segment', () => {
    process.env.SOLENOID_KEY = 'sk.spend.test-tenant.abc123';
    assert.equal(buildVerifyBudget('unknown', sandbox), undefined);
    assert.equal(buildVerifyBudget('', sandbox), undefined);
  });
});

describe('buildVerifyBudget — with a known pluginData', () => {
  it('spends at learning-loop/verify/<session> and writes the outage cache under pluginData, not HOME', async () => {
    process.env.SOLENOID_KEY = 'sk.spend.test-tenant.abc123';
    // A HOME an accidental fileStore() default would write under — the assertion
    // below proves the write landed under pluginData/solenoid instead.
    process.env.HOME = join(sandbox, 'not-the-real-home');
    const sessionId = uniqueSessionId();
    const seg = budgetScopeSegment(sessionId);
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), opts });
      return {
        ok: true,
        status: 200,
        json: async () => ({ receipt: { id: 'r1' }, remaining: {}, on_outage: 'open' }),
      };
    };

    const budget = buildVerifyBudget(sessionId, sandbox);
    assert.notEqual(budget, undefined);
    await budget.spend({ fetches: 1 });

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, new RegExp(`/v1/learning-loop/verify/${seg}$`));

    const cacheFile = join(sandbox, 'solenoid', 'outage.json');
    assert.ok(existsSync(cacheFile), 'outage cache should be written under pluginData/solenoid');
    const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
    assert.ok(`learning-loop/verify/${seg}` in cache);
  });
});

describe('buildVerifyBudget — with no pluginData (CLI run outside a plugin data dir)', () => {
  it('falls back to fileStore() default, which this test pins to a temp HOME so it never touches the real cache', async () => {
    process.env.SOLENOID_KEY = 'sk.spend.test-tenant.abc123';
    const tmpHome = join(sandbox, 'fallback-home');
    process.env.HOME = tmpHome;
    const sessionId = uniqueSessionId();
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ receipt: { id: 'r1' }, remaining: {}, on_outage: 'open' }),
    });

    const budget = buildVerifyBudget(sessionId, null);
    assert.notEqual(budget, undefined);
    await budget.spend({ fetches: 1 });

    const cacheFile = join(tmpHome, '.cache', 'solenoid', 'outage.json');
    assert.ok(
      existsSync(cacheFile),
      'the no-pluginData fallback should still be redirectable via HOME',
    );
  });
});
