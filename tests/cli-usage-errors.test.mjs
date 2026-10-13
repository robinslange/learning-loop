// Every script that reads flags through flagValue answers a flag with no
// value the same way: the message on stderr, exit 2, no stack trace.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(import.meta.dirname, '..', 'plugin', 'scripts');

const DANGLING = {
  'backfill-edges.mjs': ['--limit'],
  'cache-health-report.mjs': ['--month'],
  'normalise-frontmatter.mjs': ['--folder'],
  'refinement-candidates.mjs': ['--pairs-out'],
  'refinement-validate.mjs': ['--stdin', '--pairs'],
  'supersede-note.mjs': ['note.md', '--date'],
  'sweep-hook-replay.mjs': ['--scan-vault', '/tmp/vault', '--sid'],
  'vault-search.mjs': ['similar', 'note.md', '--top'],
};

test('every script that imports flagValue is in the dangling-flag table', () => {
  const importers = readdirSync(SCRIPTS)
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => /\bflagValue\b/.test(readFileSync(join(SCRIPTS, f), 'utf8')))
    .sort();
  assert.deepEqual(importers, Object.keys(DANGLING).sort());
});

for (const [script, argv] of Object.entries(DANGLING)) {
  test(`${script} ${argv.join(' ')}: usage line and exit 2, no stack trace`, () => {
    const home = mkdtempSync(join(tmpdir(), 'll-cli-usage-'));
    try {
      const pluginData = join(home, 'plugin-data');
      const vault = join(home, 'vault');
      mkdirSync(join(pluginData, 'retrieval'), { recursive: true });
      mkdirSync(join(pluginData, 'bin'), { recursive: true });
      mkdirSync(vault, { recursive: true });
      writeFileSync(join(pluginData, 'bin', 'll-search'), '', { mode: 0o755 });

      const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...argv], {
        input: '',
        encoding: 'utf8',
        timeout: 15000,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          CLAUDE_PLUGIN_DATA: pluginData,
          VAULT_PATH: vault,
          LL_OFFLINE: '1',
        },
      });

      const flag = argv.at(-1);
      assert.equal(r.status, 2, `exit ${r.status}\n${r.stderr}`);
      assert.match(r.stderr, new RegExp(`${flag} needs a value`));
      assert.doesNotMatch(r.stderr, /^\s+at /m);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
