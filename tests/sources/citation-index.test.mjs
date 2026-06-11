import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const runId = randomBytes(8).toString('hex');
const TEMP_ROOT = join(tmpdir(), `ll-citation-index-${runId}`);

describe('citation-index', () => {
  before(() => {
    mkdirSync(TEMP_ROOT, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = TEMP_ROOT;
  });

  after(() => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  });

  it('loadCitationIndex returns {} when no file exists', async () => {
    const { loadCitationIndex } = await import(
      `../../plugin/scripts/lib/sources/citation-index.mjs?bust=${runId}`
    );
    const index = loadCitationIndex();
    assert.deepEqual(index, {});
  });

  it('updateCitationIndex creates entry and adds noteFilename', async () => {
    const { updateCitationIndex, loadCitationIndex } = await import(
      `../../plugin/scripts/lib/sources/citation-index.mjs?bust=${runId}2`
    );
    await updateCitationIndex(
      '12345678',
      { authors: ['Smith A'], title: 'Test', year: 2020 },
      'note1.md',
    );
    const index = loadCitationIndex();
    assert.ok(index['pmid:12345678']);
    assert.ok(index['pmid:12345678'].cited_in.includes('note1.md'));
  });

  it('5 parallel updateCitationIndex calls all persist', async () => {
    const bust = runId + 'parallel';
    const { updateCitationIndex, loadCitationIndex } = await import(
      `../../plugin/scripts/lib/sources/citation-index.mjs?bust=${bust}`
    );
    const metadata = { authors: ['Jones B'], title: 'Parallel Test', year: 2021 };
    const promises = Array.from({ length: 5 }, (_, i) =>
      updateCitationIndex('99999999', metadata, `note${i}.md`),
    );
    await Promise.all(promises);
    const index = loadCitationIndex();
    assert.ok(index['pmid:99999999']);
    assert.equal(index['pmid:99999999'].cited_in.length, 5, 'all 5 notes should be recorded');
  });

  it('duplicate noteFilename not added twice', async () => {
    const bust = runId + 'dedup';
    const { updateCitationIndex, loadCitationIndex } = await import(
      `../../plugin/scripts/lib/sources/citation-index.mjs?bust=${bust}`
    );
    const metadata = { authors: ['Lee C'], title: 'Dedup Test', year: 2022 };
    await updateCitationIndex('55555555', metadata, 'same-note.md');
    await updateCitationIndex('55555555', metadata, 'same-note.md');
    const index = loadCitationIndex();
    const cited = index['pmid:55555555'].cited_in;
    assert.equal(cited.filter((n) => n === 'same-note.md').length, 1);
  });
});
