// The suite runs under tests/helpers/isolate-env.mjs. If that preload is
// dropped from the test command, plugin code spawned by a test can resolve the
// developer's live install through ~/.claude/plugins/data/.ll-data-path (#126).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

test("the suite runs with a HOME that is not the developer's", () => {
  assert.notEqual(homedir(), userInfo().homedir);
  assert.equal(existsSync(join(homedir(), '.claude', 'plugins', 'data', '.ll-data-path')), false);
});

test('the suite runs with no plugin data, vault or session id from the shell', () => {
  for (const name of [
    'CLAUDE_PLUGIN_DATA',
    'PLUGIN_DATA',
    'VAULT_PATH',
    'CLAUDE_CODE_SESSION_ID',
  ]) {
    assert.equal(process.env[name], undefined, name);
  }
});
