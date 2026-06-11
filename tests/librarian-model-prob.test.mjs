import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

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
