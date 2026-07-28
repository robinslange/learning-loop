// Regression: refinement-candidates.mjs used to hardcode the marketplace
// install path (~/.claude/plugins/data/learning-loop-learning-loop-marketplace)
// instead of resolving via lib/binary.mjs binaryPath(), so any install whose
// plugin-data lives elsewhere threw "ll-search binary not found" while every
// other ll-search caller worked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '..', 'plugin/scripts/refinement-candidates.mjs');

test('refinement-candidates resolves ll-search from CLAUDE_PLUGIN_DATA/bin', () => {
  // POSIX-only: the stub below is a `#!/bin/sh` script named `ll-search`, which
  // Windows cannot execute and binaryPath() would not resolve there anyway (it
  // looks for ll-search.exe). The resolution logic under test is platform-
  // independent; only the executable-stub fixture is not.
  if (process.platform === 'win32') return;
  const sb = mkdtempSync(join(tmpdir(), 'll-refc-bin-'));
  try {
    const vault = join(sb, 'vault');
    mkdirSync(join(vault, '1-fleeting'), { recursive: true });
    const note = join(vault, '1-fleeting', 'fresh-note.md');
    writeFileSync(note, '# fresh note\n');

    const pdDir = join(sb, 'plugin-data');
    mkdirSync(join(pdDir, 'bin'), { recursive: true });
    writeFileSync(join(pdDir, 'config.json'), '{}');
    const marker = join(sb, 'stub-invoked');
    const stub = join(pdDir, 'bin', 'll-search');
    writeFileSync(stub, `#!/bin/sh\ntouch "${marker}"\necho '[]'\n`);
    chmodSync(stub, 0o755);

    const r = spawnSync(process.execPath, [SCRIPT, note], {
      encoding: 'utf-8',
      env: {
        PATH: process.env.PATH,
        HOME: sb,
        CLAUDE_PLUGIN_DATA: pdDir,
        VAULT_PATH: vault,
      },
    });

    assert.equal(r.status, 0, `script failed: ${r.stderr}`);
    assert.ok(
      existsSync(marker),
      'the ll-search stub at $CLAUDE_PLUGIN_DATA/bin must be the binary invoked',
    );
    assert.deepEqual(JSON.parse(r.stdout), []);
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});
