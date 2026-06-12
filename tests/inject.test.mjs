import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { scrubSecrets, buildInjection, emitHookOutput, runBackendsWithRaceCap } from '../plugin/hooks/lib/inject.mjs';
import { HookConfig } from '../plugin/scripts/lib/hook-config.mjs';

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

  it('masks Slack bot/user/app tokens', () => {
    const slack = 'token=xoxb-FAKE-FAKE-not-a-real-slack-token';
    assert.ok(!scrubSecrets(slack).includes('xoxb-'));
    assert.ok(scrubSecrets(slack).includes('[REDACTED]'));

    const userToken = 'xoxp-FAKE-FAKE-test-fixture-not-real';
    assert.ok(!scrubSecrets(userToken).includes('xoxp-'));
    assert.ok(scrubSecrets(userToken).includes('[REDACTED]'));
  });

  it('masks JWTs', () => {
    const jwt = 'eyJ_fake_test_fixture.fake_payload_test.fake_signature_test';
    assert.ok(!scrubSecrets(jwt).includes('eyJ'));
    assert.ok(scrubSecrets(jwt).includes('[REDACTED]'));
  });

  it('masks PEM private key blocks across lines', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nFAKEKEYFAKEKEYFAKEKEY\n-----END PRIVATE KEY-----';
    assert.ok(!scrubSecrets(pem).includes('FAKEKEY'));
    assert.ok(scrubSecrets(pem).includes('[REDACTED]'));

    const rsaPem =
      '-----BEGIN RSA PRIVATE KEY-----\nFAKERSAKEYFAKERSAKEY\n-----END RSA PRIVATE KEY-----';
    assert.ok(!scrubSecrets(rsaPem).includes('FAKERSAKEY'));
    assert.ok(scrubSecrets(rsaPem).includes('[REDACTED]'));
  });
});

describe('buildInjection', () => {
  it('returns null when both hit lists are empty', () => {
    const result = buildInjection({
      vaultHits: [],
      episodicHits: [],
      query: 'test',
      alreadyInjected: new Map(),
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
      alreadyInjected: new Map(),
    });
    assert.ok(result);
    assert.ok(result.additionalContext.includes('From your vault'));
    assert.ok(!result.additionalContext.includes('From past conversations'));
    assert.deepEqual(result.injectedVault, [{ path: 'notes/sleep.md', level: 'body' }]);
  });

  it('filters out vault hits already injected at body level', () => {
    const result = buildInjection({
      vaultHits: [
        { title: 'Note A', path: 'a.md', body: 'Body A content here.', score: 0.95 },
        { title: 'Note B', path: 'b.md', body: 'Body B content here.', score: 0.85 },
      ],
      episodicHits: [],
      query: 'test',
      alreadyInjected: new Map([['a.md', 'body']]),
    });
    assert.ok(result);
    assert.ok(!result.additionalContext.includes('Note A'));
    assert.ok(result.additionalContext.includes('Note B'));
    assert.deepEqual(result.injectedVault, [{ path: 'b.md', level: 'body' }]);
  });

  it('treats a legacy Set of paths as body-level entries', () => {
    const result = buildInjection({
      vaultHits: [
        { title: 'Note A', path: 'a.md', body: 'Body A content here.', score: 0.95 },
        { title: 'Note B', path: 'b.md', body: 'Body B content here.', score: 0.85 },
      ],
      episodicHits: [],
      query: 'test',
      alreadyInjected: new Set(['a.md']),
    });
    assert.ok(result);
    assert.ok(!result.additionalContext.includes('Note A'));
    assert.deepEqual(result.injectedVault, [{ path: 'b.md', level: 'body' }]);
  });

  // Regression: a note that was only surfaced as a one-line pointer must still
  // qualify for body injection on a later prompt — the model never saw its
  // content. Pre-fix, pointer paths were persisted indistinguishably from
  // body-injected paths and filtered out wholesale.
  it('pointer-level dedupe entry still gets body injection as the top hit', () => {
    const result = buildInjection({
      vaultHits: [
        { title: 'Note B', path: 'b.md', body: 'Body B content here.', score: 0.95 },
        { title: 'Note C', path: 'c.md', body: 'Body C content here.', score: 0.85 },
      ],
      episodicHits: [],
      query: 'test',
      alreadyInjected: new Map([['b.md', 'pointer']]),
    });
    assert.ok(result, 'pointer-only entry must not suppress the note entirely');
    assert.ok(
      result.additionalContext.includes('Body B content here.'),
      'pointer-seen note must be body-injected when it becomes the top hit',
    );
    assert.deepEqual(result.injectedVault[0], { path: 'b.md', level: 'body' });
  });

  it('pointer-level dedupe entry suppresses a repeat pointer', () => {
    const result = buildInjection({
      vaultHits: [
        { title: 'Note A', path: 'a.md', body: 'Body A content here.', score: 0.95 },
        { title: 'Note B', path: 'b.md', body: 'Body B content here.', score: 0.9 },
        { title: 'Note C', path: 'c.md', body: 'Body C content here.', score: 0.85 },
      ],
      episodicHits: [],
      query: 'test',
      alreadyInjected: new Map([['b.md', 'pointer']]),
    });
    assert.ok(result);
    assert.ok(result.additionalContext.includes('Body A content here.'));
    assert.ok(!result.additionalContext.includes('Note B'), 'pointer must not repeat');
    assert.deepEqual(result.injectedVault, [
      { path: 'a.md', level: 'body' },
      { path: 'c.md', level: 'pointer' },
    ]);
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
      alreadyInjected: new Map(),
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
        { date: '2026-04-01', project: 'tracker-app', snippet: 'Discussed Bayesian pipeline refactor' },
        { date: '2026-04-02', project: 'acme', snippet: 'Reviewed thread-detail PR' },
        { date: '2026-04-03', project: 'dist1lled', snippet: 'Stripe integration planning' },
        { date: '2026-04-04', project: 'northwind', snippet: 'This should be excluded' },
      ],
      query: 'test',
      alreadyInjected: new Map(),
    });
    assert.ok(result);
    assert.ok(result.additionalContext.includes('From past conversations'));
    assert.ok(!result.additionalContext.includes('From your vault'));
    assert.ok(result.additionalContext.includes('Discussed Bayesian'));
    assert.ok(result.additionalContext.includes('Stripe integration'));
    assert.ok(!result.additionalContext.includes('This should be excluded'));
    assert.deepEqual(result.injectedVault, []);
  });
});

describe('buildInjection vault Related notes header', () => {
  it('includes Related notes: header before pointer list', () => {
    const result = buildInjection({
      vaultHits: [
        { title: 'Main note', path: 'main.md', body: 'The main body.', score: 0.95 },
        { title: 'Related A', path: 'a.md', body: 'A body.', score: 0.85 },
        { title: 'Related B', path: 'b.md', body: 'B body.', score: 0.80 },
      ],
      episodicHits: [],
      query: 'test',
      alreadyInjected: new Map(),
    });
    assert.ok(result.additionalContext.includes('Related notes:'));
  });
});

describe('parseEpisodic via runBackendsWithRaceCap', () => {
  it('extracts snippets from real episodic CLI output format', async () => {
    const fixture = readFileSync(join(import.meta.dirname, 'fixtures', 'episodic-sample.txt'), 'utf8');

    const mockSpawn = (cmd, _args, _opts) => {
      const closeCallbacks = [];
      const dataCallbacks = [];
      const child = {
        killed: false,
        kill: () => { child.killed = true; },
        stdout: {
          on: (evt, cb) => { if (evt === 'data') dataCallbacks.push(cb); },
        },
        stderr: { on: () => {} },
        on: (evt, cb) => {
          if (evt === 'close') closeCallbacks.push(cb);
        },
      };
      if (cmd === 'episodic-memory') {
        setTimeout(() => {
          for (const cb of dataCallbacks) cb(fixture);
          for (const cb of closeCallbacks) cb(0);
        }, 5);
      } else {
        setTimeout(() => {
          for (const cb of dataCallbacks) cb('[]');
          for (const cb of closeCallbacks) cb(0);
        }, 5);
      }
      return child;
    };

    const results = await runBackendsWithRaceCap({
      query: 'test',
      vaultDbPath: '/nonexistent',
      raceCapMs: 2000,
      _spawnFn: mockSpawn,
    });

    assert.equal(results.episodic.hits.length, 3);
    assert.equal(results.episodic.hits[0].project, '-Users-robin-dev-acme-monorepo');
    assert.equal(results.episodic.hits[0].date, '2026-01-05');
    assert.equal(results.episodic.hits[0].score, 0.02);
    assert.equal(results.episodic.hits[0].snippet, "let's do it as part of that performance improvement PR in the existing stack");
    assert.equal(results.episodic.hits[1].snippet, 'review the work carefully please');
    assert.equal(results.episodic.hits[2].snippet, 'yes');
    assert.equal(results.episodic.raced_out, false);
  });
});

describe('parseVault raced_out field', () => {
  it('returns raced_out: false on successful parse', async () => {
    const vaultJson = JSON.stringify([
      { title: 'Test', path: 'test.md', body: 'Body.', score: 0.9 },
    ]);

    const mockSpawn = (cmd, _args, _opts) => {
      const closeCallbacks = [];
      const dataCallbacks = [];
      const child = {
        killed: false,
        kill: () => { child.killed = true; },
        stdout: {
          on: (evt, cb) => { if (evt === 'data') dataCallbacks.push(cb); },
        },
        stderr: { on: () => {} },
        on: (evt, cb) => {
          if (evt === 'close') closeCallbacks.push(cb);
        },
      };
      setTimeout(() => {
        for (const cb of dataCallbacks) cb(cmd === 'll-search' ? vaultJson : '');
        for (const cb of closeCallbacks) cb(0);
      }, 5);
      return child;
    };

    const results = await runBackendsWithRaceCap({
      query: 'test',
      vaultDbPath: '/nonexistent',
      raceCapMs: 2000,
      _spawnFn: mockSpawn,
    });

    assert.equal(results.vault.raced_out, false);
    assert.equal(results.vault.hits.length, 1);
  });
});

describe('emitHookOutput', () => {
  function captureStdout(fn) {
    const chunks = [];
    const original = process.stdout.write;
    process.stdout.write = (data) => { chunks.push(data); return true; };
    try {
      fn();
    } finally {
      process.stdout.write = original;
    }
    return chunks.join('');
  }

  it('writes valid JSON envelope to stdout', () => {
    const out = captureStdout(() =>
      emitHookOutput({ event: 'NotificationSubagentStart', additionalContext: 'test context' }),
    );
    const parsed = JSON.parse(out);
    assert.ok(parsed.hookSpecificOutput);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'NotificationSubagentStart');
    assert.equal(parsed.hookSpecificOutput.additionalContext, 'test context');
  });

  it('oversized additionalContext still emits valid JSON under the cap', () => {
    const big = 'α'.repeat(20000); // multibyte: ~2 bytes/char utf8
    const out = captureStdout(() =>
      emitHookOutput({ event: 'UserPromptSubmit', additionalContext: big }),
    );
    assert.ok(
      Buffer.byteLength(out, 'utf8') <= HookConfig.HOOK_STDOUT_MAX_BYTES,
      'output must fit HOOK_STDOUT_MAX_BYTES',
    );
    const parsed = JSON.parse(out);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(parsed.hookSpecificOutput.additionalContext, /…\[truncated\]$/);
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
