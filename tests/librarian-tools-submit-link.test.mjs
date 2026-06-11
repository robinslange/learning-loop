import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const runId = randomBytes(4).toString('hex');
const TEMP_ROOT = join(tmpdir(), `ll-librarian-tools-${runId}`);
const TEMP_VAULT = join(TEMP_ROOT, 'vault');
const TEMP_DATA = join(TEMP_ROOT, 'plugin-data');

describe('submitLink defensive checks', () => {
  let submitLink;
  let loadState;
  let resetState;
  let appendItem;
  let newItemId;

  before(async () => {
    mkdirSync(join(TEMP_VAULT, '3-permanent'), { recursive: true });
    mkdirSync(join(TEMP_DATA, 'librarian'), { recursive: true });
    process.env.VAULT_PATH = TEMP_VAULT;
    process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;

    writeFileSync(join(TEMP_VAULT, '3-permanent', 'note-a.md'), '# A\n');
    writeFileSync(join(TEMP_VAULT, '3-permanent', 'note-b.md'), '# B\n');
    writeFileSync(join(TEMP_VAULT, '3-permanent', 'note-c.md'), '# C\n');

    const tools = await import(
      `../scripts/lib/librarian-tools.mjs?bust=${randomBytes(4).toString('hex')}`
    );
    const queue = await import(
      `../scripts/librarian/queue.mjs?bust=${randomBytes(4).toString('hex')}`
    );
    const { executeTool } = tools;
    submitLink = (args) => executeTool('submit_link', args);
    loadState = queue.loadState;
    resetState = queue.resetState;
    appendItem = queue.appendItem;
    newItemId = queue.newItemId;
  });

  after(() => {
    rmSync(TEMP_ROOT, { recursive: true, force: true });
    delete process.env.VAULT_PATH;
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  beforeEach(() => {
    resetState();
    rmSync(join(TEMP_DATA, 'librarian', 'queue.jsonl'), { force: true });
  });

  it('F4: rejects when target file does not exist (fails fast before other checks)', async () => {
    const r = await submitLink({
      target: '3-permanent/ghost.md',
      suggested_link: '3-permanent/note-a.md',
      confidence: 'high',
      reason: 'test',
    });
    assert.equal(r, 'Rejected: target file does not exist');
    assert.equal(loadState().counters.rejected_missing_target, 1);
  });

  it('F4: missing target wins over missing suggested (counter does not double-count)', async () => {
    const r = await submitLink({
      target: '3-permanent/ghost.md',
      suggested_link: '3-permanent/also-ghost.md',
      confidence: 'high',
      reason: 'test',
    });
    assert.equal(r, 'Rejected: target file does not exist');
    const state = loadState();
    assert.equal(state.counters.rejected_missing_target, 1);
    assert.equal(state.counters.rejected_missing_file || 0, 0);
  });

  it('F4: existing target but missing suggested still hits the missing-file path', async () => {
    const r = await submitLink({
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/ghost.md',
      confidence: 'high',
      reason: 'test',
    });
    assert.equal(r, 'Rejected: suggested_link file does not exist');
    const state = loadState();
    assert.equal(state.counters.rejected_missing_file, 1);
    assert.equal(state.counters.rejected_missing_target || 0, 0);
  });

  it('F3: rejects duplicate suggestion (same target+suggested in pending state)', async () => {
    const first = await submitLink({
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/note-b.md',
      confidence: 'high',
      reason: 'first',
    });
    assert.ok(first.startsWith('Queued link suggestion:'));

    const second = await submitLink({
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/note-b.md',
      confidence: 'high',
      reason: 'duplicate',
    });
    assert.equal(second, 'Rejected: duplicate suggestion already queued');
    assert.equal(loadState().counters.rejected_duplicate, 1);
  });

  it('F3: allows same target with different suggested_link', async () => {
    const first = await submitLink({
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/note-b.md',
      confidence: 'high',
      reason: 'first',
    });
    assert.ok(first.startsWith('Queued link suggestion:'));

    const second = await submitLink({
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/note-c.md',
      confidence: 'high',
      reason: 'different suggested',
    });
    assert.ok(second.startsWith('Queued link suggestion:'));
    assert.equal(loadState().counters.rejected_duplicate || 0, 0);
  });

  it('F3: does NOT dedup against terminal status=approved (past decision, allow re-queue)', async () => {
    appendItem({
      id: newItemId(),
      task: 'link_suggestion',
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/note-b.md',
      confidence: 'high',
      reason: 'old',
      status: 'approved',
      created_at: new Date().toISOString(),
    });

    const r = await submitLink({
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/note-b.md',
      confidence: 'high',
      reason: 'new',
    });
    assert.ok(r.startsWith('Queued link suggestion:'));
    assert.equal(loadState().counters.rejected_duplicate || 0, 0);
  });

  it('F3: DOES dedup against status=acknowledged (non-terminal)', async () => {
    appendItem({
      id: newItemId(),
      task: 'link_suggestion',
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/note-b.md',
      confidence: 'high',
      reason: 'staged',
      status: 'acknowledged',
      created_at: new Date().toISOString(),
    });

    const r = await submitLink({
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/note-b.md',
      confidence: 'high',
      reason: 'dup',
    });
    assert.equal(r, 'Rejected: duplicate suggestion already queued');
    assert.equal(loadState().counters.rejected_duplicate, 1);
  });

  it('F3: does NOT dedup against terminal status=rejected or obsolete', async () => {
    appendItem({
      id: newItemId(),
      task: 'link_suggestion',
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/note-b.md',
      confidence: 'high',
      reason: 'old',
      status: 'rejected',
      created_at: new Date().toISOString(),
    });
    appendItem({
      id: newItemId(),
      task: 'link_suggestion',
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/note-c.md',
      confidence: 'high',
      reason: 'old',
      status: 'obsolete',
      created_at: new Date().toISOString(),
    });

    const r1 = await submitLink({
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/note-b.md',
      confidence: 'high',
      reason: 'new',
    });
    assert.ok(r1.startsWith('Queued link suggestion:'));

    const r2 = await submitLink({
      target: '3-permanent/note-a.md',
      suggested_link: '3-permanent/note-c.md',
      confidence: 'high',
      reason: 'new',
    });
    assert.ok(r2.startsWith('Queued link suggestion:'));
    assert.equal(loadState().counters.rejected_duplicate || 0, 0);
  });
});
