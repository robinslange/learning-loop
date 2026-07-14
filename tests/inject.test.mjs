import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  scrubSecrets,
  buildInjection,
  buildQuery,
  emitHookOutput,
  runBackendsWithRaceCap,
} from '../plugin/hooks/lib/inject.mjs';
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
    const pem = '-----BEGIN PRIVATE KEY-----\nFAKEKEYFAKEKEYFAKEKEY\n-----END PRIVATE KEY-----';
    assert.ok(!scrubSecrets(pem).includes('FAKEKEY'));
    assert.ok(scrubSecrets(pem).includes('[REDACTED]'));

    const rsaPem =
      '-----BEGIN RSA PRIVATE KEY-----\nFAKERSAKEYFAKERSAKEY\n-----END RSA PRIVATE KEY-----';
    assert.ok(!scrubSecrets(rsaPem).includes('FAKERSAKEY'));
    assert.ok(scrubSecrets(rsaPem).includes('[REDACTED]'));
  });
});

describe('buildInjection', () => {
  it('returns null when vault hits are empty', () => {
    const result = buildInjection({
      vaultHits: [],
      query: 'test',
      alreadyInjected: new Map(),
    });
    assert.equal(result, null);
  });

  it('returns vault-only payload and never emits an episodic section', () => {
    const result = buildInjection({
      vaultHits: [
        { title: 'Sleep cycles', path: 'notes/sleep.md', body: 'Short body.', score: 0.92 },
      ],
      query: 'sleep',
      alreadyInjected: new Map(),
    });
    assert.ok(result);
    assert.ok(result.additionalContext.includes('From your vault'));
    assert.ok(!result.additionalContext.includes('## From past conversations'));
    assert.deepEqual(result.injectedVault, [{ path: 'notes/sleep.md', level: 'body' }]);
  });

  it('labels the top-match score as "match score", not cosine similarity', () => {
    // The score is a raw RRF fusion sum from ll-search, not a cosine value —
    // presenting it as "similarity" misrepresents the scale to the model.
    const result = buildInjection({
      vaultHits: [
        { title: 'Sleep cycles', path: 'notes/sleep.md', body: 'Short body.', score: 0.42 },
      ],
      query: 'sleep',
      alreadyInjected: new Map(),
    });
    assert.ok(result.additionalContext.includes('match score 0.42'));
    assert.ok(!result.additionalContext.includes('similarity'));
  });

  it('payload opens with a directive that travels with the content', () => {
    const out = buildInjection({
      vaultHits: [{ path: 'a.md', title: 'alpha', score: 0.41, body: 'Alpha body text. More.' }],
      query: 'q',
      alreadyInjected: new Map(),
    });
    assert.match(out.additionalContext.split('\n')[0], /apply it and say "Recall:/);
  });

  it('filters out vault hits already injected at body level', () => {
    const result = buildInjection({
      vaultHits: [
        { title: 'Note A', path: 'a.md', body: 'Body A content here.', score: 0.95 },
        { title: 'Note B', path: 'b.md', body: 'Body B content here.', score: 0.85 },
      ],
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
      vaultHits: [{ title: 'Long note', path: 'long.md', body: longBody, score: 0.9 }],
      query: 'test',
      alreadyInjected: new Map(),
    });
    assert.ok(result);
    const ctx = result.additionalContext;
    const headerStart = ctx.indexOf('## From your vault');
    const bodyStart = ctx.indexOf('\n\n', headerStart) + 2;
    const bodySection = ctx.slice(bodyStart);
    assert.ok(bodySection.length <= 1200 + 200);
    assert.match(bodySection, /[.!?]$/m);
    const lastWord = bodySection.trimEnd().split(/\s+/).pop();
    assert.ok(!lastWord.includes('-'), 'last word should be complete');
  });

  it('never renders a "From past conversations" section', () => {
    const result = buildInjection({
      vaultHits: [{ title: 'Note A', path: 'a.md', body: 'Body A content here.', score: 0.95 }],
      query: 'test',
      alreadyInjected: new Map(),
    });
    assert.ok(result);
    assert.ok(!result.additionalContext.includes('## From past conversations'));
  });
});

describe('buildInjection vault Related notes header', () => {
  it('includes Related notes: header before pointer list', () => {
    const result = buildInjection({
      vaultHits: [
        { title: 'Main note', path: 'main.md', body: 'The main body.', score: 0.95 },
        { title: 'Related A', path: 'a.md', body: 'A body.', score: 0.85 },
        { title: 'Related B', path: 'b.md', body: 'B body.', score: 0.8 },
      ],
      query: 'test',
      alreadyInjected: new Map(),
    });
    assert.ok(result.additionalContext.includes('Related notes:'));
  });
});

describe('buildQuery', () => {
  it('long prompts search alone; short prompts blend prior context', () => {
    const messages = [
      'we were discussing GraphQL subscriptions',
      'and the websocket drop',
      'PROMPT',
    ];
    const longPrompt = 'p'.repeat(120);
    assert.equal(
      buildQuery({ prompt: longPrompt, messages, soloMinChars: 80 }),
      longPrompt.slice(0, 400),
    );
    const shortPrompt = 'fix the flaky one';
    const q = buildQuery({ prompt: shortPrompt, messages, soloMinChars: 80 });
    assert.ok(q.includes('GraphQL subscriptions'), 'short prompt must blend prior context');
  });
});

describe('runBackendsWithRaceCap vault-only', () => {
  it('returns raced_out: false on successful parse', async () => {
    const vaultJson = JSON.stringify([
      { title: 'Test', path: 'test.md', body: 'Body.', score: 0.9 },
    ]);

    const mockSpawn = (cmd, _args, _opts) => {
      const closeCallbacks = [];
      const dataCallbacks = [];
      const child = {
        killed: false,
        kill: () => {
          child.killed = true;
        },
        stdout: {
          on: (evt, cb) => {
            if (evt === 'data') dataCallbacks.push(cb);
          },
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

  it('returns { vault } only and spawns exactly one child', async () => {
    let spawnCount = 0;
    const mockSpawn = (cmd, _args, _opts) => {
      spawnCount++;
      const closeCallbacks = [];
      const dataCallbacks = [];
      const child = {
        killed: false,
        kill: () => {
          child.killed = true;
        },
        stdout: {
          on: (evt, cb) => {
            if (evt === 'data') dataCallbacks.push(cb);
          },
        },
        stderr: { on: () => {} },
        on: (evt, cb) => {
          if (evt === 'close') closeCallbacks.push(cb);
        },
      };
      setTimeout(() => {
        for (const cb of dataCallbacks) cb('[]');
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

    assert.equal(spawnCount, 1, 'only the vault backend should be spawned');
    assert.deepEqual(Object.keys(results), ['vault']);
  });
});

describe('emitHookOutput', () => {
  function captureStdout(fn) {
    const chunks = [];
    const original = process.stdout.write;
    process.stdout.write = (data) => {
      chunks.push(data);
      return true;
    };
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
  it('sends SIGTERM to the slow vault backend on race timeout', async () => {
    const signals = { 'll-search': null };

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
  });
});
