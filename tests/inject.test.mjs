import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { scrubSecrets, buildInjection, emitHookOutput, runBackendsWithRaceCap } from '../hooks/lib/inject.mjs';

describe('scrubSecrets', () => {
  it('masks AWS access key', () => {
    assert.equal(scrubSecrets('key=AKIAIOSFODNN7EXAMPLE'), 'key=[REDACTED]');
  });

  it('masks GitHub PAT (ghp_ and gho_)', () => {
    const ghp = scrubSecrets('token: ghp_abc123DEF456ghi789jkl012mno345pqr678');
    assert.ok(!ghp.includes('ghp_'));
    assert.ok(ghp.includes('[REDACTED]'));

    const gho = scrubSecrets('token: gho_abc123DEF456ghi789jkl012mno345pqr678');
    assert.ok(!gho.includes('gho_'));
    assert.ok(gho.includes('[REDACTED]'));
  });

  it('masks OpenAI-shaped key', () => {
    const result = scrubSecrets('sk-proj-abc123DEF456ghi789jkl012');
    assert.ok(!result.includes('sk-'));
    assert.ok(result.includes('[REDACTED]'));
  });

  it('masks Bearer token', () => {
    const result = scrubSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
    assert.ok(!result.includes('eyJhbGci'));
    assert.ok(result.includes('[REDACTED]'));
  });

  it('returns unchanged when no secrets present', () => {
    const plain = 'just some normal text with no secrets';
    assert.equal(scrubSecrets(plain), plain);
  });
});

describe('buildInjection', () => {
  it('returns null when both hit lists are empty', () => {
    const result = buildInjection({
      vaultHits: [],
      episodicHits: [],
      query: 'test',
      alreadyInjectedPaths: new Set(),
    });
    assert.equal(result, null);
  });

  it('returns vault-only payload when episodic is empty', () => {
    const result = buildInjection({
      vaultHits: [
        { title: 'Sleep cycles', path: 'notes/sleep.md', body: 'Short body.', score: 0.92 },
      ],
      episodicHits: [],
      query: 'sleep',
      alreadyInjectedPaths: new Set(),
    });
    assert.ok(result);
    assert.ok(result.additionalContext.includes('From your vault'));
    assert.ok(!result.additionalContext.includes('From past conversations'));
    assert.deepEqual(result.injectedVaultPaths, ['notes/sleep.md']);
  });

  it('filters out vault hits in alreadyInjectedPaths', () => {
    const result = buildInjection({
      vaultHits: [
        { title: 'Note A', path: 'a.md', body: 'Body A content here.', score: 0.95 },
        { title: 'Note B', path: 'b.md', body: 'Body B content here.', score: 0.85 },
      ],
      episodicHits: [],
      query: 'test',
      alreadyInjectedPaths: new Set(['a.md']),
    });
    assert.ok(result);
    assert.ok(!result.additionalContext.includes('Note A'));
    assert.ok(result.additionalContext.includes('Note B'));
    assert.deepEqual(result.injectedVaultPaths, ['b.md']);
  });

  it('truncates top vault body at sentence boundary under 1200 chars', () => {
    const sentences = [];
    for (let i = 0; i < 20; i++) {
      sentences.push(`This is sentence number ${i} with some padding text to make it longer.`);
    }
    const longBody = sentences.join(' ');
    assert.ok(longBody.length > 1200);

    const result = buildInjection({
      vaultHits: [
        { title: 'Long note', path: 'long.md', body: longBody, score: 0.90 },
      ],
      episodicHits: [],
      query: 'test',
      alreadyInjectedPaths: new Set(),
    });
    assert.ok(result);
    const ctx = result.additionalContext;
    const bodyStart = ctx.indexOf('\n\n') + 2;
    const bodySection = ctx.slice(bodyStart);
    assert.ok(bodySection.length <= 1200 + 200);
    assert.match(bodySection, /[.!?]$/m);
    const lastWord = bodySection.trimEnd().split(/\s+/).pop();
    assert.ok(!lastWord.includes('-'), 'last word should be complete');
  });

  it('renders episodic-only payload with up to 3 pointers', () => {
    const result = buildInjection({
      vaultHits: [],
      episodicHits: [
        { date: '2026-04-01', project: 'thalen', snippet: 'Discussed Bayesian pipeline refactor' },
        { date: '2026-04-02', project: 'kinso', snippet: 'Reviewed thread-detail PR' },
        { date: '2026-04-03', project: 'dist1lled', snippet: 'Stripe integration planning' },
        { date: '2026-04-04', project: 'solwen', snippet: 'This should be excluded' },
      ],
      query: 'test',
      alreadyInjectedPaths: new Set(),
    });
    assert.ok(result);
    assert.ok(result.additionalContext.includes('From past conversations'));
    assert.ok(!result.additionalContext.includes('From your vault'));
    assert.ok(result.additionalContext.includes('Discussed Bayesian'));
    assert.ok(result.additionalContext.includes('Stripe integration'));
    assert.ok(!result.additionalContext.includes('This should be excluded'));
    assert.deepEqual(result.injectedVaultPaths, []);
  });
});

describe('emitHookOutput', () => {
  it('writes valid JSON envelope to stdout', () => {
    const chunks = [];
    const original = process.stdout.write;
    process.stdout.write = (data) => { chunks.push(data); return true; };
    try {
      emitHookOutput({ event: 'NotificationSubagentStart', additionalContext: 'test context' });
    } finally {
      process.stdout.write = original;
    }
    const parsed = JSON.parse(chunks.join(''));
    assert.ok(parsed.hookSpecificOutput);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'NotificationSubagentStart');
    assert.equal(parsed.hookSpecificOutput.additionalContext, 'test context');
  });
});

describe('runBackendsWithRaceCap zombie kill', () => {
  it('sends SIGTERM to both slow backends on race timeout', async () => {
    const signals = { 'll-search': null, 'episodic-memory': null };

    const mockSpawn = (cmd, _args, _opts) => {
      const closeCallbacks = [];
      const child = {
        killed: false,
        kill: (sig) => {
          child.killed = true;
          signals[cmd] = sig;
          setTimeout(() => {
            for (const cb of closeCallbacks) cb(143);
          }, 5);
        },
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (evt, cb) => {
          if (evt === 'close') closeCallbacks.push(cb);
        },
      };
      return child;
    };

    await runBackendsWithRaceCap({
      query: 'q',
      vaultDbPath: '/nonexistent',
      raceCapMs: 30,
      _spawnFn: mockSpawn,
    });

    assert.equal(signals['ll-search'], 'SIGTERM', 'll-search should be killed with SIGTERM');
    assert.equal(signals['episodic-memory'], 'SIGTERM', 'episodic-memory should be killed with SIGTERM');
  });
});
