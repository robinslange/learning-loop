import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import {
  readCount,
  claimFetch,
  budgetScopeSegment,
  buildSolenoidStore,
} from '../../plugin/scripts/lib/fetch-budget.mjs';
const MODULE_URL = new URL('../../plugin/scripts/lib/fetch-budget.mjs', import.meta.url).href;
let tmpPd;

before(() => {
  tmpPd = mkdtempSync(join(tmpdir(), 'fetch-budget-test-'));
});

after(() => {
  rmSync(tmpPd, { recursive: true, force: true });
});

function claimInChild(sid, pd, budget) {
  const code =
    'import(process.argv[1]).then((m) => process.stdout.write(String(m.claimFetch(process.argv[2], process.argv[3], Number(process.argv[4])))))';
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, MODULE_URL, sid, pd, String(budget)]);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('exit', (status) =>
      status === 0 ? resolve(out === 'true') : reject(new Error(`child exited ${status}`)),
    );
  });
}

describe('fetch-budget claimFetch/readCount', () => {
  it('starts at 0 when nothing has been claimed', () => {
    assert.equal(readCount('fresh', tmpPd), 0);
  });

  it('grants exactly budget claims, and a refusal consumes nothing', () => {
    const sid = 'sequential';
    const results = Array.from({ length: 5 }, () => claimFetch(sid, tmpPd, 3));
    assert.deepEqual(results, [true, true, true, false, false]);
    assert.equal(readCount(sid, tmpPd), 3);
  });

  it('isolates budgets per session', () => {
    assert.equal(claimFetch('one', tmpPd, 1), true);
    assert.equal(claimFetch('one', tmpPd, 1), false);
    assert.equal(claimFetch('two', tmpPd, 1), true);
  });

  it('grants exactly budget claims when 15 processes claim a budget of 10 at once', async () => {
    const sid = 'concurrent';
    const granted = await Promise.all(
      Array.from({ length: 15 }, () => claimInChild(sid, tmpPd, 10)),
    );
    assert.equal(granted.filter(Boolean).length, 10);
    assert.equal(readCount(sid, tmpPd), 10);
  });

  it('grants a claim whose slot directory cannot be created', () => {
    assert.equal(claimFetch('s', '/proc/definitely/not/writable', 1), true);
  });

  it('refuses a claim whose slot cannot be written, and records nothing', () => {
    const sid = 'unwritable-slot';
    const dir = join(tmpPd, 'fetch-budget', sid);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    try {
      assert.equal(claimFetch(sid, tmpPd, 1), false);
      assert.equal(readCount(sid, tmpPd), 0);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe('budgetScopeSegment', () => {
  it('maps session ids onto the scope grammar', () => {
    assert.equal(budgetScopeSegment('3F2A-99bc_X'), '3f2a-99bc_x');
    assert.equal(budgetScopeSegment('a b/c'), 'a-b-c');
    assert.equal(budgetScopeSegment('unknown'), null);
    assert.equal(budgetScopeSegment(''), null);
    assert.equal(budgetScopeSegment('...'), null);
  });

  it("truncates to the scope grammar's 64-character segment limit", () => {
    const long = 'x'.repeat(80);
    const seg = budgetScopeSegment(long);
    assert.equal(seg.length, 64);
    assert.equal(seg, 'x'.repeat(64));
  });

  it('rejects only a segment that is ALL dots, not one that merely starts or ends with one', () => {
    // Solenoid's own scope grammar (checkScope) rejects a path segment iff it
    // is entirely dots (traversal-shaped: '.', '..', ...) — dots elsewhere in
    // the segment are fine. These pin the '^...$' anchors on both ends: an
    // unanchored-start or unanchored-end regex would wrongly null out a
    // segment that merely starts or ends with a dot run.
    assert.equal(budgetScopeSegment('x...'), 'x...');
    assert.equal(budgetScopeSegment('...x'), '...x');
    assert.equal(budgetScopeSegment('...'), null);
  });
});

describe('buildSolenoidStore', () => {
  let origFetch;
  let origKey;
  beforeEach(() => {
    origFetch = globalThis.fetch;
    origKey = process.env.SOLENOID_KEY;
    process.env.SOLENOID_KEY = 'sk.spend.test-tenant.abc123';
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origKey === undefined) delete process.env.SOLENOID_KEY;
    else process.env.SOLENOID_KEY = origKey;
  });

  it('spends at learning-loop/research/<seg> and caches on_outage under PLUGIN_DATA/solenoid, not the SDK default', async () => {
    const sid = 'store-path-test';
    const seg = budgetScopeSegment(sid);
    let seenUrl;
    globalThis.fetch = async (url) => {
      seenUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ receipt: { id: 'r1' }, remaining: {}, on_outage: 'open' }),
      };
    };
    const store = buildSolenoidStore(sid, tmpPd);
    assert.equal(await store.tryBump(), true);
    assert.match(seenUrl, new RegExp(`/v1/learning-loop/research/${seg}$`));

    const cacheFile = join(tmpPd, 'solenoid', 'outage.json');
    assert.ok(existsSync(cacheFile), 'outage cache should land under PLUGIN_DATA/solenoid');
    const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
    assert.equal(cache[`learning-loop/research/${seg}`], 'open');
  });

  it('persists the outage mode across separate buildSolenoidStore() calls (one per gateway invocation)', async () => {
    const sid = 'store-persist-test';
    // First gateway invocation: a successful spend that caches on_outage: 'open'.
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ receipt: { id: 'r1' }, remaining: {}, on_outage: 'open' }),
    });
    await buildSolenoidStore(sid, tmpPd).tryBump();

    // Second gateway invocation: a fresh buildSolenoidStore() instance, as the
    // one-process-per-fetch gateway pattern actually builds it, with Solenoid
    // now unreachable. A pluginData-scoped fileStore reads the cached 'open'
    // mode and fails open (true); the SDK's in-memory default would start
    // empty in this fresh instance and fail closed (false) instead.
    globalThis.fetch = async () => {
      throw new TypeError('network unreachable');
    };
    const store2 = buildSolenoidStore(sid, tmpPd);
    assert.equal(await store2.tryBump(), true);
  });
});
