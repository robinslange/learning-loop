// tests/librarian-daemon.test.mjs : unit tests for scripts/librarian/daemon.mjs
//
// Tests: SIGTERM drain, AbortSignal loop exit, state save on drain, __test__ surface,
// change-gated note picking, and the queue cap as a stop.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { HttpResponse, chat, httpError, startOllamaMock, tags } from './helpers/ollama-mock.mjs';

const runId = randomBytes(4).toString('hex');

// One server for the file: MSW patches process-global fetch, so two of them
// would fight over the same hook. A default /api/tags handler stands in for a
// reachable ollama, which every runDaemon call probes for before it does
// anything else.
const server = startOllamaMock(tags(() => HttpResponse.json({ models: [] })));

/** Collect the JSON log lines a block writes to stderr. */
async function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join('');
}
const TEMP_ROOT = join(tmpdir(), 'll-daemon-' + runId);
const TEMP_VAULT = join(TEMP_ROOT, 'vault');
const TEMP_DATA = join(TEMP_ROOT, 'plugin-data');
const LIB_DIR = join(TEMP_DATA, 'librarian');

describe('librarian-daemon', () => {
  before(() => {
    mkdirSync(join(TEMP_VAULT, '3-permanent'), { recursive: true });
    mkdirSync(LIB_DIR, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;
    process.env.VAULT_PATH = TEMP_VAULT;
  });

  after(() => {
    rmSync(TEMP_ROOT, { recursive: true, force: true });
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.VAULT_PATH;
  });

  it('__test__ on librarian.mjs includes investigateNote', async () => {
    const mod = await import('../plugin/scripts/librarian.mjs?bust=daemon-test-' + runId);
    assert.ok(typeof mod.__test__ === 'object', '__test__ must be exported');
    const keys = Object.keys(mod.__test__);
    assert.ok(keys.includes('voiceCheck'), 'voiceCheck missing');
    assert.ok(keys.includes('tagCheck'), 'tagCheck missing');
    assert.ok(keys.includes('duplicateCheck'), 'duplicateCheck missing');
    assert.ok(keys.includes('waitForOllama'), 'waitForOllama missing');
    assert.ok(keys.includes('investigateNote'), 'investigateNote missing');
  });

  it('runDaemon exits cleanly when AbortSignal is pre-aborted', async () => {
    const { runDaemon } = await import(
      '../plugin/scripts/librarian/daemon.mjs?bust=daemon-preabort-' + runId
    );
    const ac = new AbortController();
    ac.abort();

    // Build a minimal mock db
    const mockDb = {
      exec: () => [{ values: [] }],
    };

    const cfg = {
      enabled: true,
      model: 'test-model',
      paceMs: 10,
      queueCap: 200,
      ollamaUrl: 'http://localhost:11434',
      pauseOnBattery: false,
      batteryPollMs: 60000,
      linkPrompt: '',
      voicePrompt: '',
      tagPrompt: '',
      duplicatePrompt: '',
      structuralTags: new Set(),
    };

    // waitForOllama will try to fetch; intercept with a mock
    await runDaemon({ signal: ac.signal, configOverride: cfg, deps: { db: mockDb } });
    // No assertion needed — just must not throw and must return
  });

  it('runDaemon saves state on abort (drain path)', async () => {
    const { runDaemon } = await import(
      '../plugin/scripts/librarian/daemon.mjs?bust=daemon-drain-' + runId
    );
    const ac = new AbortController();

    const mockDb = { exec: () => [{ values: [['3-permanent/note.md']] }] };
    const cfg = {
      enabled: true,
      model: 'test-model',
      paceMs: 5000,
      queueCap: 200,
      ollamaUrl: 'http://localhost:11434',
      pauseOnBattery: false,
      batteryPollMs: 60000,
      linkPrompt: '',
      voicePrompt: '',
      tagPrompt: '',
      duplicatePrompt: '',
      structuralTags: new Set(),
    };

    // Pre-set state to something recognizable
    const { saveState, loadState, resetState } = await import(
      '../plugin/scripts/librarian/queue.mjs?bust=daemon-drain-q-' + runId
    );
    resetState();
    saveState({ visited: [], notes_visited: 0, counters: {}, last_note: null, started_at: null });

    const daemonPromise = runDaemon({
      signal: ac.signal,
      configOverride: cfg,
      deps: { db: mockDb },
    });

    // Abort shortly after start
    setTimeout(() => ac.abort(), 50);
    await daemonPromise;

    // State file must exist after drain
    const statePath = join(LIB_DIR, 'state.json');
    assert.ok(existsSync(statePath), 'state.json must exist after drain');
  });

  it('runDaemon returns immediately when disabled in config', async () => {
    const { runDaemon } = await import(
      '../plugin/scripts/librarian/daemon.mjs?bust=daemon-disabled-' + runId
    );
    const cfg = { enabled: false };
    const start = Date.now();
    await runDaemon({ configOverride: cfg });
    assert.ok(Date.now() - start < 500, 'should return quickly when disabled');
  });
  // The whole request body lives in ollama-client's chat() now, which spells
  // two of these fields differently on the way in (`keepAlive`) and out
  // (`keep_alive`). Nothing else reads the body, so without this a rename could
  // drop `keep_alive`, `logprobs` or `stream:false` and every other test would
  // stay green while the daemon quietly reloaded the model on each turn and
  // lost the confidence trace submit_link scores against.
  it('sends the tool-calling contract ollama needs and stops when no tool is called', async () => {
    const bodies = [];
    server.use(
      chat(async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ message: { role: 'assistant', content: 'nothing to link' } });
      }),
    );
    const { investigateNote } = await import(
      '../plugin/scripts/librarian/daemon.mjs?bust=daemon-contract-' + runId
    );
    const { TOOL_DEFS } = await import('../plugin/scripts/librarian/tools/index.mjs');

    await investigateNote(
      '3-permanent/orphan.md',
      'link_check',
      {
        ollamaUrl: 'http://localhost:11434',
        model: 'test-model',
        linkPrompt: 'investigate',
        keepAlive: '5m',
      },
      { exec: () => [{ values: [] }] },
      () => {},
    );

    assert.equal(bodies.length, 1, 'a reply with no tool_calls must end the loop');
    const body = bodies[0];
    assert.equal(body.model, 'test-model');
    assert.equal(body.stream, false);
    assert.equal(body.keep_alive, '5m');
    assert.equal(body.logprobs, true);
    assert.equal(body.top_logprobs, 20);
    assert.deepEqual(body.options, { temperature: 0, num_predict: 1000 });
    assert.equal(body.tools.length, TOOL_DEFS.length);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content, 'investigate');
    assert.match(body.messages[1].content, /3-permanent\/orphan\.md/);
  });

  it('investigateNote reports the ollama HTTP status, not a TypeError, on an error response', async () => {
    const { investigateNote } = await import(
      '../plugin/scripts/librarian/daemon.mjs?bust=daemon-httperr-' + runId
    );

    server.use(chat(() => httpError(400, 'context length exceeded')));

    const log = await captureStderr(() =>
      investigateNote(
        '3-permanent/oversized.md',
        'link_check',
        {
          ollamaUrl: 'http://localhost:11434',
          model: 'test-model',
          linkPrompt: 'investigate',
          keepAlive: '5m',
        },
        { exec: () => [{ values: [] }] },
        () => {},
      ),
    );
    assert.ok(
      !log.includes('Cannot read properties of undefined'),
      'must not surface a TypeError from destructuring an error body:\n' + log,
    );
    assert.match(log, /ollama HTTP 400/, 'must name the HTTP status that actually failed');
  });
  it('investigateNote reports a 200 that carries no completion', async () => {
    const { investigateNote } = await import(
      '../plugin/scripts/librarian/daemon.mjs?bust=daemon-nomsg-' + runId
    );

    server.use(chat(() => HttpResponse.json({ error: 'model not found' })));

    const log = await captureStderr(() =>
      investigateNote(
        '3-permanent/no-completion.md',
        'link_check',
        {
          ollamaUrl: 'http://localhost:11434',
          model: 'test-model',
          linkPrompt: 'investigate',
          keepAlive: '5m',
        },
        { exec: () => [{ values: [] }] },
        () => {},
      ),
    );
    assert.ok(
      !log.includes('Cannot read properties of undefined'),
      'a 200 with no message must not become a TypeError:\n' + log,
    );
    assert.match(log, /ollama returned no message: model not found/);
  });
  const gatedCfg = {
    enabled: true,
    model: 'test-model',
    paceMs: 10,
    queueCap: 200,
    ollamaUrl: 'http://localhost:11434',
    pauseOnBattery: false,
    batteryPollMs: 60000,
    linkPrompt: '',
    voicePrompt: '',
    tagPrompt: '',
    duplicatePrompt: '',
    structuralTags: new Set(),
  };

  // One linked, well-tagged note, so the only task it ever needs is duplicate_check.
  const dbOf = (paths) => ({
    exec: (sql) => {
      if (sql.includes('SELECT path FROM notes')) return [{ values: paths.map((p) => [p]) }];
      if (sql.includes('COUNT(*)')) return [{ values: [[1]] }];
      return [{ values: [['alpha beta']] }];
    },
  });

  function writeNote(rel, mtime) {
    const full = join(TEMP_VAULT, rel);
    writeFileSync(full, '# ' + rel + '\n\nA body.\n');
    utimesSync(full, mtime, mtime);
    return statSync(full).mtimeMs;
  }

  function countChats() {
    const counter = { calls: 0 };
    server.use(
      chat(() => {
        counter.calls++;
        return HttpResponse.json({ message: { role: 'assistant', content: '{}' } });
      }),
    );
    return counter;
  }

  async function runFor(ms, tag, cfg, db) {
    const { runDaemon } = await import(
      '../plugin/scripts/librarian/daemon.mjs?bust=daemon-' + tag + '-' + runId
    );
    const ac = new AbortController();
    const done = runDaemon({ signal: ac.signal, configOverride: cfg, deps: { db } });
    setTimeout(() => ac.abort(), ms);
    await captureStderr(() => done);
  }

  async function freshQueue(tag) {
    const q = await import('../plugin/scripts/librarian/queue.mjs?bust=gated-q-' + tag + runId);
    q.resetState();
    rmSync(join(LIB_DIR, 'queue.jsonl'), { force: true });
    return q;
  }

  it('pickNote skips a note unchanged since its check and picks it again once touched', async () => {
    const { pickNote } = await import(
      '../plugin/scripts/librarian/daemon-helpers.mjs?bust=pick-' + runId
    );
    const rel = '3-permanent/pick.md';
    const mtimeMs = writeNote(rel, new Date(Date.now() - 60000));

    assert.deepEqual(pickNote([rel], {}), { path: rel, mtimeMs });
    assert.equal(pickNote([rel], { [rel]: mtimeMs }), null);
    assert.equal(pickNote(['3-permanent/gone.md'], {}), null, 'a note missing on disk is skipped');

    const now = new Date();
    utimesSync(join(TEMP_VAULT, rel), now, now);
    assert.equal(pickNote([rel], { [rel]: mtimeMs })?.path, rel);
  });

  it('checks a changed note once, then leaves it alone', async () => {
    const q = await freshQueue('once');
    const rel = '3-permanent/once.md';
    const mtimeMs = writeNote(rel, new Date(Date.now() - 60000));
    q.saveState({ checked: { [rel]: mtimeMs - 1000 }, notes_visited: 0, counters: {} });
    countChats();

    await runFor(300, 'once', gatedCfg, dbOf([rel]));

    const state = q.loadState();
    assert.equal(state.checked[rel], mtimeMs);
    assert.equal(state.notes_visited, 1, 'an unchanged note must not be checked again');
  });

  it('migrates a visited-list state by marking every current note checked, without a model call', async () => {
    const q = await freshQueue('migrate');
    const rel = '3-permanent/migrate.md';
    const mtimeMs = writeNote(rel, new Date(Date.now() - 60000));
    q.saveState({ visited: ['3-permanent/other.md'], notes_visited: 7, counters: {} });
    const chats = countChats();

    await runFor(100, 'migrate', gatedCfg, dbOf([rel]));

    const state = q.loadState();
    assert.equal(chats.calls, 0);
    assert.deepEqual(state.checked, { [rel]: mtimeMs });
    assert.equal(state.visited, undefined);
    assert.equal(state.notes_visited, 7);
  });

  it('a full queue stops all model work and trims an over-cap queue to the newest items', async () => {
    const q = await freshQueue('cap');
    const rel = '3-permanent/unchecked.md';
    writeNote(rel, new Date(Date.now() - 60000));
    q.appendItem({
      id: 'old',
      task: 'tag_suggestion',
      target: rel,
      status: 'pending',
      created_at: new Date(Date.now() - 120000).toISOString(),
    });
    q.appendItem({
      id: 'new',
      task: 'tag_suggestion',
      target: rel,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    const chats = countChats();

    await runFor(100, 'cap', { ...gatedCfg, queueCap: 1 }, dbOf([rel]));

    assert.equal(chats.calls, 0, 'no model call while the queue is at its cap');
    assert.deepEqual(
      q.pendingItems().map((i) => i.id),
      ['new'],
    );
    assert.equal(q.loadState().checked[rel], undefined, 'the unchecked note waits for room');
  });
});
