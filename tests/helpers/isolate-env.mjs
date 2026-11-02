// Loaded with --import ahead of the test runner (package.json "test", and the
// CI step that runs node --test directly), so every test file and every
// process a test spawns starts from this environment.
//
// Plugin code that finds no CLAUDE_PLUGIN_DATA falls back to the marker at
// ~/.claude/plugins/data/.ll-data-path, which names the developer's live
// install. A test that spawned plugin code with the real HOME then wrote into
// that install: logs, convergence state, and once a binary download that ran
// restartWatch against the live watch daemon (#126). A fresh HOME has no
// marker, and the variables below would otherwise point a test at live state.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'll-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
for (const name of [
  'CLAUDE_PLUGIN_DATA',
  'PLUGIN_DATA',
  'VAULT_PATH',
  'CLAUDE_CODE_SESSION_ID',
  'LL_REFLECT_SID',
]) {
  delete process.env[name];
}
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
