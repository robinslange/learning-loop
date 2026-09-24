import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  loadCitationIndex,
  updateCitationIndex,
} from '../../plugin/scripts/lib/sources/citation-index.mjs';

const MODULE = resolve(
  fileURLToPath(import.meta.url),
  '../../../plugin/scripts/lib/sources/citation-index.mjs',
);
const PLUGIN_ROOT = resolve(MODULE, '../../../..');

describe('citation-index', () => {
  let pd;

  beforeEach(() => {
    pd = mkdtempSync(join(tmpdir(), 'll-citation-index-'));
    process.env.CLAUDE_PLUGIN_DATA = pd;
  });

  afterEach(() => {
    delete process.env.CLAUDE_PLUGIN_DATA;
    rmSync(pd, { recursive: true, force: true });
  });

  it('loadCitationIndex returns {} when no file exists', () => {
    assert.deepEqual(loadCitationIndex(), {});
  });

  it('updateCitationIndex creates entry and adds noteFilename', async () => {
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
    const metadata = { authors: ['Jones B'], title: 'Parallel Test', year: 2021 };
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => updateCitationIndex('99999999', metadata, `note${i}.md`)),
    );
    assert.equal(loadCitationIndex()['pmid:99999999'].cited_in.length, 5);
  });

  it('duplicate noteFilename not added twice', async () => {
    const metadata = { authors: ['Lee C'], title: 'Dedup Test', year: 2022 };
    await updateCitationIndex('55555555', metadata, 'same-note.md');
    await updateCitationIndex('55555555', metadata, 'same-note.md');
    const cited = loadCitationIndex()['pmid:55555555'].cited_in;
    assert.equal(cited.filter((n) => n === 'same-note.md').length, 1);
  });

  it('resolves the plugin data dir on each call, not at import', async () => {
    await updateCitationIndex('11111111', { title: 'A' }, 'a.md');
    assert.ok(existsSync(join(pd, 'data', 'citation-index.json')));

    const other = mkdtempSync(join(tmpdir(), 'll-citation-index-other-'));
    try {
      process.env.CLAUDE_PLUGIN_DATA = other;
      assert.deepEqual(loadCitationIndex(), {});
      await updateCitationIndex('22222222', { title: 'B' }, 'b.md');
      assert.deepEqual(Object.keys(loadCitationIndex()), ['pmid:22222222']);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('writes nothing, anywhere, when no plugin data dir resolves', () => {
    const home = mkdtempSync(join(tmpdir(), 'll-citation-index-home-'));
    try {
      const script = `
        const m = await import(${JSON.stringify(pathToFileURL(MODULE).href)});
        await m.updateCitationIndex('33333333', { title: 'C' }, 'c.md');
        console.log(JSON.stringify(m.loadCitationIndex()));
      `;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), '{}');
      assert.ok(
        !existsSync(join(PLUGIN_ROOT, 'data')),
        'must not write into the plugin install dir',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
