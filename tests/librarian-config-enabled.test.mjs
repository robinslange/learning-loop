// tests/librarian-config-enabled.test.mjs : the librarian must fail closed.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadLibrarianConfig, __test__ } from '../plugin/scripts/librarian/config.mjs';
import { resetConfigCache } from '../plugin/scripts/lib/config.mjs';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'll-lib-cfg-'));
const CONFIG_PATH = join(DATA_DIR, 'config.json');
let origData;

before(() => {
  origData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = DATA_DIR;
});

after(() => {
  if (origData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = origData;
  resetConfigCache();
  __test__.resetCache();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

function enabledFor(librarian) {
  writeFileSync(CONFIG_PATH, JSON.stringify(librarian === undefined ? {} : { librarian }));
  resetConfigCache();
  __test__.resetCache();
  return loadLibrarianConfig({ configPath: CONFIG_PATH }).enabled;
}

describe('librarian enabled default', () => {
  it('stays disabled when the librarian block is absent', () => {
    assert.equal(enabledFor(undefined), false);
  });

  it('stays disabled when the block exists without an enabled key', () => {
    assert.equal(enabledFor({ model: 'gemma4:e2b' }), false);
  });

  it('activates only on an explicit true', () => {
    assert.equal(enabledFor({ enabled: true }), true);
  });

  it('rejects truthy non-boolean values', () => {
    assert.equal(enabledFor({ enabled: 'yes' }), false);
  });
});
