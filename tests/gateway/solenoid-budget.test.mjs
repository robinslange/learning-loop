// tests/gateway/solenoid-budget.test.mjs — the gateway's fetch budget, backed by Solenoid
// when SOLENOID_KEY is set. Stubs only globalThis.fetch (the transport the vendored
// Solenoid SDK calls), never runGateway's own deps — this exercises the real
// solenoid()/spend() code path, not a fake of it.

import { describe, it, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { runGateway } from '../../plugin/bin/source-gateway.mjs';
import { budgetScopeSegment } from '../../plugin/scripts/lib/fetch-budget.mjs';

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

// The vendored SDK's fileStore() (used for the outage-mode cache, same as
// production) writes to the real ~/.cache/solenoid/outage.json — there's no
// dir override in this integration, matching the docs' "use fileStore() for
// CLIs" guidance exactly. Every test uses a fresh random session id so it
// never reads a stale entry, and this sweeps those test-only keys back out
// so repeated runs don't leave garbage in the developer's real cache file.
const OUTAGE_CACHE = join(homedir(), '.cache', 'solenoid', 'outage.json');
const usedSessionIds = [];

function uniqueSessionId() {
  const id = `solenoid-test-${randomUUID()}`;
  usedSessionIds.push(id);
  return id;
}

after(() => {
  if (!existsSync(OUTAGE_CACHE)) return;
  try {
    const data = JSON.parse(readFileSync(OUTAGE_CACHE, 'utf8'));
    let changed = false;
    for (const id of usedSessionIds) {
      const key = `learning-loop/research/${budgetScopeSegment(id)}`;
      if (key in data) {
        delete data[key];
        changed = true;
      }
    }
    if (changed) writeFileSync(OUTAGE_CACHE, JSON.stringify(data));
  } catch {
    // best-effort cleanup only
  }
});

function fakeFetchSource() {
  return {
    id: 'raw',
    fetch: mock.fn(async () => ({ text: 'body', ok: true, reason: 'ok' })),
  };
}

describe('gateway fetch budget backed by Solenoid (SOLENOID_KEY set)', () => {
  it('spends one "fetches" unit at learning-loop/research/<session> and lets the fetch through', async () => {
    const sessionId = uniqueSessionId();
    const seg = budgetScopeSegment(sessionId);
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return {
        ok: true,
        status: 200,
        json: async () => ({ receipt: { id: 'r1' }, remaining: {}, on_outage: 'closed' }),
      };
    };
    const source = fakeFetchSource();
    const out = await runGateway(['fetch', '--url', 'https://example.com'], {
      resolveSlot: () => source,
      sessionId,
      pluginData: null,
    });

    assert.equal(out.doc.ok, true);
    assert.equal(out.doc.text, 'body');
    assert.equal(source.fetch.mock.callCount(), 1);

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, new RegExp(`/v1/learning-loop/research/${seg}$`));
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers.authorization, 'Bearer sk.spend.test-tenant.abc123');
    assert.deepEqual(JSON.parse(calls[0].opts.body), { fetches: 1 });
  });

  it('refuses the fetch when Solenoid returns limit_exceeded for the fetches unit', async () => {
    const sessionId = uniqueSessionId();
    const seg = budgetScopeSegment(sessionId);
    globalThis.fetch = async () => ({
      ok: false,
      status: 402,
      json: async () => ({
        error: 'limit_exceeded',
        scope: `learning-loop/research/${seg}`,
        unit: 'fetches',
        resets: null,
        limit: 10,
        used: 10,
        requested: 1,
      }),
    });
    const source = fakeFetchSource();
    const out = await runGateway(['fetch', '--url', 'https://example.com'], {
      resolveSlot: () => source,
      sessionId,
      pluginData: null,
    });

    assert.equal(out.doc.ok, false);
    assert.equal(out.doc.reason, 'fetch_budget_exceeded');
    assert.equal(out.source_used, 'raw');
    assert.equal(source.fetch.mock.callCount(), 0);
  });

  it('refuses the fetch when Solenoid is unreachable and no outage mode is cached (fails closed)', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      return { ok: false, status: 503, json: async () => ({}) };
    };
    const sessionId = uniqueSessionId();
    const source = fakeFetchSource();
    const out = await runGateway(['fetch', '--url', 'https://example.com'], {
      resolveSlot: () => source,
      sessionId,
      pluginData: null,
    });

    assert.equal(out.doc.ok, false);
    assert.equal(out.doc.reason, 'fetch_budget_exceeded');
    assert.equal(source.fetch.mock.callCount(), 0);
    // one attempt plus one retry, per the SDK's transient-error handling
    assert.equal(callCount, 2);
  });

  it('rethrows a LimitExceeded for an unrelated unit instead of treating it as the fetch budget', async () => {
    const sessionId = uniqueSessionId();
    globalThis.fetch = async () => ({
      ok: false,
      status: 402,
      json: async () => ({ error: 'limit_exceeded', scope: 'learning-loop', unit: 'spends', resets: null }),
    });
    const source = fakeFetchSource();
    await assert.rejects(
      () =>
        runGateway(['fetch', '--url', 'https://example.com'], {
          resolveSlot: () => source,
          sessionId,
          pluginData: null,
        }),
      (e) => e.constructor.name === 'LimitExceeded' && e.unit === 'spends',
    );
  });

  it('skips Solenoid enforcement gracefully when the session id cannot form a scope segment', async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const source = fakeFetchSource();
    const out = await runGateway(['fetch', '--url', 'https://example.com'], {
      resolveSlot: () => source,
      sessionId: 'unknown',
      pluginData: null,
    });

    assert.equal(out.doc.ok, true);
    assert.equal(calls.length, 0);
  });
});

describe('gateway fetch budget with SOLENOID_KEY unset (behaviour unchanged)', () => {
  it('never calls fetch (no Solenoid transport) and falls through to the file-backed store', async () => {
    delete process.env.SOLENOID_KEY;
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const source = fakeFetchSource();
    // No pluginData -> file store also resolves to null -> no enforcement, matching
    // the pre-Solenoid graceful-degrade behaviour this path must keep.
    const out = await runGateway(['fetch', '--url', 'https://example.com'], {
      resolveSlot: () => source,
      sessionId: uniqueSessionId(),
      pluginData: null,
    });

    assert.equal(out.doc.ok, true);
    assert.equal(calls.length, 0);
  });
});
