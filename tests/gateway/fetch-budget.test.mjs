import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  readCount,
  tryBump,
  budgetScopeSegment,
  buildSolenoidStore,
} from '../../plugin/scripts/lib/fetch-budget.mjs';

const sessionId = 'test-session-abc';
let tmpPd;

before(() => {
  // mkdtempSync, not a Date.now()-suffixed path: under Stryker's concurrency,
  // sibling mutant runs of this same file can spawn within the same
  // millisecond and race the *directory itself*, not just its session ids
  // (reproduced: 2/8 sibling `node -e` launches shared one Date.now() tick).
  // A shared tmpPd meant two processes' "isolates counters per sessionId"
  // subtests bumped the same iso-a-<ms> file, doubling the observed count.
  tmpPd = mkdtempSync(join(tmpdir(), 'fetch-budget-test-'));
});

after(() => {
  rmSync(tmpPd, { recursive: true, force: true });
});

describe('fetch-budget readCount', () => {
  it('starts at 0 when no file exists', () => {
    assert.equal(readCount(sessionId, tmpPd), 0);
  });

  it('bumps the counter file at exactly PLUGIN_DATA/fetch-budget/<sessionId>.count', () => {
    const sid = 'path-check';
    tryBump(sid, tmpPd, 10);
    assert.equal(readFileSync(join(tmpPd, 'fetch-budget', `${sid}.count`), 'utf8'), '1');
  });

  it('ignores a stray count file at the "unknown" path — the guard, not a missing file, is why unknown reads as 0', () => {
    // Pre-seed the exact file 'unknown' would resolve to, with a nonzero count.
    // If the sessionId === 'unknown' guard were dropped (or its literal
    // changed), readCount would fall through to this file and return 5, not 0.
    mkdirSync(join(tmpPd, 'fetch-budget'), { recursive: true });
    writeFileSync(join(tmpPd, 'fetch-budget', 'unknown.count'), '5', 'utf8');
    assert.equal(readCount('unknown', tmpPd), 0);
  });

  it('trims whitespace/newlines a hand-edited or foreign-written count file might carry', () => {
    const sid = 'whitespace-padded';
    mkdirSync(join(tmpPd, 'fetch-budget'), { recursive: true });
    writeFileSync(join(tmpPd, 'fetch-budget', `${sid}.count`), '  7\n', 'utf8');
    assert.equal(readCount(sid, tmpPd), 7);
  });

  it('returns 0, not undefined, when the count "file" cannot be read at all (EISDIR)', () => {
    // existsSync is true (something is there), but readFileSync itself throws.
    // Distinguishes the catch's `return 0` from an accidental fall-through.
    const sid = 'unreadable-path';
    mkdirSync(join(tmpPd, 'fetch-budget', `${sid}.count`), { recursive: true });
    assert.equal(readCount(sid, tmpPd), 0);
  });

  it('isolates counters per sessionId', () => {
    const a = `iso-a-${randomUUID()}`,
      b = `iso-b-${randomUUID()}`;
    tryBump(a, tmpPd, 10);
    tryBump(a, tmpPd, 10);
    tryBump(b, tmpPd, 10);
    assert.equal(readCount(a, tmpPd), 2);
    assert.equal(readCount(b, tmpPd), 1);
  });

  it('gracefully returns 0 when pluginData is null', () => {
    assert.equal(readCount(sessionId, null), 0);
  });

  it('gracefully returns 0 when sessionId is empty', () => {
    assert.equal(readCount('', tmpPd), 0);
  });

  it('gracefully returns 0 when sessionId is "unknown"', () => {
    assert.equal(readCount('unknown', tmpPd), 0);
  });
});

describe('tryBump', () => {
  it('allows exactly budget calls in-process, then denies the next one', () => {
    const sid = 'exhaust-single-process';
    for (let i = 0; i < 3; i++) {
      assert.equal(tryBump(sid, tmpPd, 3), true, `call ${i + 1}/3 should be allowed`);
    }
    assert.equal(tryBump(sid, tmpPd, 3), false);
    assert.equal(readCount(sid, tmpPd), 3);
  });
  it('never lets more than budget concurrent processes through, however contended the lock is', async () => {
    // Under real contention, a losing process can be refused for either of
    // two reasons: the counter was already at budget (a legitimate deny), or
    // the lock's own retry budget (400x5ms) ran out first (a fail-closed
    // timeout, since F-7). Both return the identical boolean `false` from
    // tryBump, and each child process reports only that single bit over
    // stdout ('0' or '1') — nothing distinguishes the two reasons from out
    // here. So "granted === budget exactly when no timeouts occurred" is not
    // an assertion this test can make from outside the child processes: we'd
    // need tryBump itself to expose *why* it refused (a production API
    // change, not asked for and not worth it for a test). What the test CAN
    // assert from outside: the cap is never exceeded (not "exactly budget
    // got through", which flaked under the old fail-open-on-timeout
    // behaviour whenever a timeout let an over-budget caller slip in as a
    // false '1'), and that something was granted at all (an always-refusing
    // tryBump — e.g. a regression that fails every fetch closed — would
    // otherwise satisfy "granted <= budget" trivially at granted=0).
    const sid = `race-${randomUUID()}`;
    const budget = 10;
    const mod = new URL('../../plugin/scripts/lib/fetch-budget.mjs', import.meta.url).href;
    const startAt = Date.now() + 1500;
    const script = `import { tryBump } from ${JSON.stringify(mod)}; while (Date.now() < ${startAt}) {} process.stdout.write(tryBump(${JSON.stringify(sid)}, ${JSON.stringify(tmpPd)}, ${budget}) ? '1' : '0');`;
    const outs = await Promise.all(
      Array.from(
        { length: 30 },
        () =>
          new Promise((resolve) => {
            const p = spawn(process.execPath, ['--input-type=module', '-e', script]);
            let s = '';
            p.stdout.on('data', (d) => (s += d));
            p.on('close', () => resolve(s));
          }),
      ),
    );
    const granted = outs.filter((o) => o === '1').length;
    assert.ok(
      granted > 0,
      'nothing was granted — cannot distinguish this from an always-refusing tryBump',
    );
    assert.ok(granted <= budget, `granted ${granted} exceeds budget ${budget}`);
    // Every grant left its own mark on disk, and nothing else could have:
    // the only way tryBump returns true and writes is the in-lock branch
    // below budget, so the on-disk count must equal exactly what was granted.
    assert.equal(readCount(sid, tmpPd), granted);
  });
  it('degrades to allowing when pluginData or sessionId is unusable', () => {
    assert.equal(tryBump('s', null, 0), true);
    assert.equal(tryBump('unknown', tmpPd, 0), true);
    assert.equal(tryBump('s', '/proc/definitely/not/writable', 0), true);
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

describe('tryBump — lock retry budget', () => {
  it('waits out a lock a sibling process holds for 250ms, within its 400x5ms retry window', async () => {
    const sid = 'lock-contention';
    const file = join(tmpPd, 'fetch-budget', `${sid}.count`);
    mkdirSync(join(tmpPd, 'fetch-budget'), { recursive: true });
    const flmUrl = new URL('../../plugin/scripts/lib/file-lock.mjs', import.meta.url).href;
    // A clean acquire-hold-release cycle, not a died-while-holding one: this
    // exercises tryBump's retry BUDGET (how long it keeps retrying a lock
    // held by a live, cooperating process), not file-lock's separate
    // stale-PID reclaim path — reclaim depends on process liveness checks
    // that a busy dev/CI box (many short-lived sibling processes, exactly
    // Stryker's own concurrency) can make unreliable via PID reuse.
    const holderScript = `
      import { acquireLock, releaseLock } from ${JSON.stringify(flmUrl)};
      const handle = acquireLock(${JSON.stringify(file)});
      process.stdout.write('LOCKED\\n');
      const until = Date.now() + 250;
      while (Date.now() < until) {}
      releaseLock(handle);
      process.exit(0);
    `;
    const holder = spawn(process.execPath, ['--input-type=module', '-e', holderScript]);
    await new Promise((resolve, reject) => {
      holder.stdout.once('data', (d) =>
        String(d).includes('LOCKED') ? resolve() : reject(new Error(String(d))),
      );
      holder.once('error', reject);
    });

    // The holder releases the lock ~250ms after signaling LOCKED. That
    // exceeds file-lock's own default retry budget (5 x 20ms = 100ms) but is
    // well inside tryBump's configured 400 x 5ms = 2000ms — if tryBump's
    // options were ever dropped to file-lock's defaults, this would time out
    // and fail open (returning true without writing), which this test
    // catches via the count, not tryBump's return value (both paths return
    // true; only a real acquisition actually increments it).
    const result = tryBump(sid, tmpPd, 10);
    assert.equal(result, true);
    assert.equal(readCount(sid, tmpPd), 1);
  });

  it('refuses a fetch when a sibling process holds the lock past its retry budget', async () => {
    const sid = 'lock-timeout';
    const file = join(tmpPd, 'fetch-budget', `${sid}.count`);
    mkdirSync(join(tmpPd, 'fetch-budget'), { recursive: true });
    const flmUrl = new URL('../../plugin/scripts/lib/file-lock.mjs', import.meta.url).href;
    // 400 retries x 5ms nominal is 2000ms, but each failed attempt also pays
    // for an openSync + a stale-check readFileSync + a process.kill(pid, 0)
    // probe, which measured out at ~2480-2500ms wall time in this
    // environment. The holder must outlast that whole budget, not just the
    // nominal 2000ms, or it releases mid-retry and this test flakes exactly
    // the way the old race test did. 4000ms gives >1.5s of margin.
    const holdMs = 4000;
    const holderScript = `
      import { acquireLock, releaseLock } from ${JSON.stringify(flmUrl)};
      const handle = acquireLock(${JSON.stringify(file)});
      process.stdout.write('LOCKED\\n');
      const until = Date.now() + ${holdMs};
      while (Date.now() < until) {}
      releaseLock(handle);
      process.exit(0);
    `;
    const holder = spawn(process.execPath, ['--input-type=module', '-e', holderScript]);
    await new Promise((resolve, reject) => {
      holder.stdout.once('data', (d) =>
        String(d).includes('LOCKED') ? resolve() : reject(new Error(String(d))),
      );
      holder.once('error', reject);
    });

    // A lock timeout must fail this fetch closed — never fall through to the
    // old catch-all `return true` a stuck lock used to trigger — so the
    // counter this call would have written is never created at all.
    const result = tryBump(sid, tmpPd, 10);
    assert.equal(result, false);
    assert.equal(readCount(sid, tmpPd), 0);

    await new Promise((resolve) => holder.on('close', resolve));
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
