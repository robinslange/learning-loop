import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const runId = randomBytes(4).toString('hex');
const TEMP_ROOT = join(tmpdir(), `ll-librarian-mp-${runId}`);

// constants.mjs reads process.env.{VAULT_PATH, CLAUDE_PLUGIN_DATA} at first
// evaluation and caches them. Sibling test files may have already pulled in
// constants.mjs with their own env, so we set ours BEFORE any import touches
// librarian-tools (which transitively loads constants). Sub-suites that need
// different paths must spawn child processes.
const FILE_VAULT = join(TEMP_ROOT, 'vault');
const FILE_DATA = join(TEMP_ROOT, 'plugin-data');
mkdirSync(join(FILE_VAULT, '3-permanent'), { recursive: true });
mkdirSync(join(FILE_DATA, 'librarian'), { recursive: true });
writeFileSync(join(FILE_VAULT, '3-permanent', 'note-a.md'), '# A\n');
writeFileSync(join(FILE_VAULT, '3-permanent', 'note-b.md'), '# B\n');
process.env.VAULT_PATH = FILE_VAULT;
process.env.CLAUDE_PLUGIN_DATA = FILE_DATA;

describe('extractModelProb', () => {
  let extractModelProb;

  before(async () => {
    const tools = await import(
      `../scripts/lib/librarian-tools.mjs?bust=${randomBytes(4).toString('hex')}`
    );
    extractModelProb = tools.extractModelProb;
  });

  it('returns normalized P(high) when emitted label is "high"', () => {
    const trace = [
      {
        token: 'preamble',
        logprob: -0.1,
        top_logprobs: [{ token: 'preamble', logprob: -0.1 }],
      },
      {
        token: 'high',
        logprob: Math.log(0.7),
        top_logprobs: [
          { token: 'high', logprob: Math.log(0.7) },
          { token: 'review', logprob: Math.log(0.3) },
        ],
      },
    ];
    const p = extractModelProb(trace, 'high');
    assert.ok(p > 0.69 && p < 0.71, `expected ~0.70, got ${p}`);
  });

  it('returns normalized P(review) when emitted label is "review"', () => {
    const trace = [
      {
        token: 'review',
        logprob: Math.log(0.4),
        top_logprobs: [
          { token: 'review', logprob: Math.log(0.4) },
          { token: 'high', logprob: Math.log(0.6) },
        ],
      },
    ];
    const p = extractModelProb(trace, 'review');
    assert.ok(p > 0.39 && p < 0.41, `expected ~0.40, got ${p}`);
  });

  it('takes the LAST qualifying token position (closest to tool call args)', () => {
    const trace = [
      {
        token: 'thinking',
        logprob: -0.5,
        top_logprobs: [
          { token: 'high', logprob: Math.log(0.2) },
          { token: 'review', logprob: Math.log(0.8) },
        ],
      },
      {
        token: 'high',
        logprob: Math.log(0.9),
        top_logprobs: [
          { token: 'high', logprob: Math.log(0.9) },
          { token: 'review', logprob: Math.log(0.1) },
        ],
      },
    ];
    const p = extractModelProb(trace, 'high');
    assert.ok(p > 0.89 && p < 0.91, `expected ~0.90 from last position, got ${p}`);
  });

  it('returns null when no position contains both enum values', () => {
    const trace = [
      {
        token: 'foo',
        logprob: -0.1,
        top_logprobs: [
          { token: 'foo', logprob: -0.1 },
          { token: 'bar', logprob: -2 },
        ],
      },
    ];
    assert.equal(extractModelProb(trace, 'high'), null);
  });

  it('returns null on empty or missing trace', () => {
    assert.equal(extractModelProb(null, 'high'), null);
    assert.equal(extractModelProb([], 'high'), null);
    assert.equal(extractModelProb([{ top_logprobs: [] }], 'high'), null);
  });

  it('handles tokenizer variants via substring match (e.g. " high", "High")', () => {
    const trace = [
      {
        token: ' high',
        logprob: Math.log(0.6),
        top_logprobs: [
          { token: ' high', logprob: Math.log(0.6) },
          { token: ' review', logprob: Math.log(0.4) },
        ],
      },
    ];
    const p = extractModelProb(trace, 'high');
    assert.ok(p > 0.59 && p < 0.61, `expected ~0.60 with substring match, got ${p}`);
  });

  it('returns null when chosen label not recognized', () => {
    const trace = [
      {
        token: 'high',
        logprob: -0.5,
        top_logprobs: [
          { token: 'high', logprob: -0.5 },
          { token: 'review', logprob: -0.5 },
        ],
      },
    ];
    assert.equal(extractModelProb(trace, 'medium'), null);
  });
});

describe('submitLink model_prob + cosine_score plumbing', () => {
  let submitLink;
  let resetState;
  let readQueue;
  let executeTool;

  before(async () => {
    const tools = await import(
      `../scripts/lib/librarian-tools.mjs?bust=${randomBytes(4).toString('hex')}`
    );
    const queue = await import(
      `../scripts/lib/librarian-queue.mjs?bust=${randomBytes(4).toString('hex')}`
    );
    executeTool = tools.executeTool;
    submitLink = (args) => executeTool('submit_link', args);
    resetState = queue.resetState;
    readQueue = queue.readQueue;
  });

  beforeEach(() => {
    resetState();
    rmSync(join(FILE_DATA, 'librarian', 'queue.jsonl'), { force: true });
  });

  it('persists model_prob when in [0,1]', async () => {
    const r = await submitLink({
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/note-b.md',
      confidence: 'high',
      reason: 't',
      model_prob: 0.73,
    });
    assert.ok(r.startsWith('Queued link suggestion:'));
    const items = readQueue();
    assert.equal(items.length, 1);
    assert.equal(items[0].model_prob, 0.73);
  });

  it('skips model_prob when out of range, item still queued', async () => {
    const r = await submitLink({
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/note-b.md',
      confidence: 'high',
      reason: 't',
      model_prob: 1.5,
    });
    assert.ok(r.startsWith('Queued link suggestion:'));
    const items = readQueue();
    assert.equal(items.length, 1);
    assert.equal(items[0].model_prob, undefined);
  });

  it('skips model_prob when negative', async () => {
    const r = await submitLink({
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/note-b.md',
      confidence: 'high',
      reason: 't',
      model_prob: -0.1,
    });
    assert.ok(r.startsWith('Queued link suggestion:'));
    assert.equal(readQueue()[0].model_prob, undefined);
  });

  it('skips model_prob when null/undefined/NaN', async () => {
    await submitLink({
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/note-b.md',
      confidence: 'high',
      reason: 't',
      model_prob: null,
    });
    let items = readQueue();
    assert.equal(items[0].model_prob, undefined);

    resetState();
    rmSync(join(FILE_DATA, 'librarian', 'queue.jsonl'), { force: true });

    await submitLink({
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/note-b.md',
      confidence: 'high',
      reason: 't',
      model_prob: NaN,
    });
    items = readQueue();
    assert.equal(items[0].model_prob, undefined);
  });

  it('persists cosine_score when in [0,1]', async () => {
    await submitLink({
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/note-b.md',
      confidence: 'high',
      reason: 't',
      cosine_score: 0.42,
    });
    assert.equal(readQueue()[0].cosine_score, 0.42);
  });

  it('executeTool injects cosine_score from ctx.neighbourScores for submit_link', async () => {
    const ctx = {
      neighbourScores: new Map([['3-permanent/note-b.md', 0.51]]),
      modelProb: 0.82,
    };
    await executeTool(
      'submit_link',
      {
        target: '3-permanent/note-a.md',
        suggested_link: '3-permanent/note-b.md',
        confidence: 'high',
        reason: 't',
      },
      ctx,
    );
    const item = readQueue()[0];
    assert.equal(item.cosine_score, 0.51);
    assert.equal(item.model_prob, 0.82);
  });

  it('executeTool tolerates missing ctx (backwards compatible)', async () => {
    await executeTool('submit_link', {
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/note-b.md',
      confidence: 'high',
      reason: 't',
    });
    const item = readQueue()[0];
    assert.equal(item.cosine_score, undefined);
    assert.equal(item.model_prob, undefined);
  });

  it('TOOL_DEFS submit_link schema does NOT expose model_prob or cosine_score to the model', async () => {
    const tools = await import(
      `../scripts/lib/librarian-tools.mjs?bust=${randomBytes(4).toString('hex')}`
    );
    const def = tools.TOOL_DEFS.find((t) => t.function.name === 'submit_link');
    assert.ok(def);
    assert.ok(!('model_prob' in def.function.parameters.properties));
    assert.ok(!('cosine_score' in def.function.parameters.properties));
    assert.ok(!def.function.parameters.required.includes('model_prob'));
  });
});

describe('triage-link-suggestions --sort', () => {
  let queuePath;
  const SUITE_DATA = join(TEMP_ROOT, 'triage-data');

  before(() => {
    mkdirSync(join(SUITE_DATA, 'librarian'), { recursive: true });
    queuePath = join(SUITE_DATA, 'librarian', 'queue.jsonl');
  });

  after(() => {
    rmSync(SUITE_DATA, { recursive: true, force: true });
  });

  function writeQueue(items) {
    writeFileSync(queuePath, items.map((i) => JSON.stringify(i)).join('\n') + '\n');
  }

  function runTriage(args) {
    const script = join(import.meta.dirname, '..', 'scripts', 'triage-link-suggestions.mjs');
    return spawnSync('node', [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_DATA: SUITE_DATA },
    });
  }

  it('--sort model_prob defaults to desc', () => {
    writeQueue([
      {
        id: 'a',
        task: 'link_suggestion',
        status: 'pending',
        target: 't/a.md',
        suggested_link: 's/a.md',
        model_prob: 0.2,
        cosine_score: 0.9,
        created_at: '2026-05-11T00:00:00Z',
      },
      {
        id: 'b',
        task: 'link_suggestion',
        status: 'pending',
        target: 't/b.md',
        suggested_link: 's/b.md',
        model_prob: 0.9,
        cosine_score: 0.3,
        created_at: '2026-05-11T00:00:00Z',
      },
      {
        id: 'c',
        task: 'link_suggestion',
        status: 'pending',
        target: 't/c.md',
        suggested_link: 's/c.md',
        model_prob: 0.5,
        cosine_score: 0.5,
        created_at: '2026-05-11T00:00:00Z',
      },
    ]);
    const r = runTriage(['--sort', 'model_prob']);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n').filter((l) => /→/.test(l));
    // Expect b (0.9), c (0.5), a (0.2)
    assert.match(lines[0], /t\/b\.md/);
    assert.match(lines[1], /t\/c\.md/);
    assert.match(lines[2], /t\/a\.md/);
  });

  it('items lacking model_prob sink below items with model_prob', () => {
    writeQueue([
      {
        id: 'noprob',
        task: 'link_suggestion',
        status: 'pending',
        target: 't/no.md',
        suggested_link: 's/no.md',
        cosine_score: 0.99,
        created_at: '2026-05-11T00:00:00Z',
      },
      {
        id: 'haspr',
        task: 'link_suggestion',
        status: 'pending',
        target: 't/has.md',
        suggested_link: 's/has.md',
        model_prob: 0.1,
        cosine_score: 0.1,
        created_at: '2026-05-11T00:00:00Z',
      },
    ]);
    const r = runTriage(['--sort', 'model_prob']);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n').filter((l) => /→/.test(l));
    assert.match(lines[0], /t\/has\.md/);
    assert.match(lines[1], /t\/no\.md/);
  });

  it('ties on model_prob broken by cosine asc', () => {
    writeQueue([
      {
        id: 'hi',
        task: 'link_suggestion',
        status: 'pending',
        target: 't/hicos.md',
        suggested_link: 's/x.md',
        model_prob: 0.5,
        cosine_score: 0.9,
        created_at: '2026-05-11T00:00:00Z',
      },
      {
        id: 'lo',
        task: 'link_suggestion',
        status: 'pending',
        target: 't/locos.md',
        suggested_link: 's/y.md',
        model_prob: 0.5,
        cosine_score: 0.1,
        created_at: '2026-05-11T00:00:00Z',
      },
    ]);
    const r = runTriage(['--sort', 'model_prob']);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n').filter((l) => /→/.test(l));
    assert.match(lines[0], /t\/locos\.md/, 'low cosine wins tie');
    assert.match(lines[1], /t\/hicos\.md/);
  });

  it('items lacking BOTH model_prob and cosine sink to bottom', () => {
    writeQueue([
      {
        id: 'naked',
        task: 'link_suggestion',
        status: 'pending',
        target: 't/naked.md',
        suggested_link: 's/x.md',
        created_at: '2026-05-11T00:00:00Z',
      },
      {
        id: 'coso',
        task: 'link_suggestion',
        status: 'pending',
        target: 't/coso.md',
        suggested_link: 's/y.md',
        cosine_score: 0.5,
        created_at: '2026-05-11T00:00:00Z',
      },
      {
        id: 'mp',
        task: 'link_suggestion',
        status: 'pending',
        target: 't/mp.md',
        suggested_link: 's/z.md',
        model_prob: 0.4,
        created_at: '2026-05-11T00:00:00Z',
      },
    ]);
    const r = runTriage(['--sort', 'model_prob']);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n').filter((l) => /→/.test(l));
    assert.match(lines[0], /t\/mp\.md/);
    // coso has cosine but not model_prob — second
    assert.match(lines[1], /t\/coso\.md/);
    assert.match(lines[2], /t\/naked\.md/);
  });

  it('rejects unknown --sort value', () => {
    const r = runTriage(['--sort', 'banana']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--sort must be/);
  });
});
