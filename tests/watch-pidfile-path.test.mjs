import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { skipOnWindows } from './helpers/platform.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'plugin', 'scripts', 'watch.mjs');

describe(
  'll-watch pidfile path alignment with watch-daemon',
  { skip: skipOnWindows('shebang stub: #!/bin/sh stubs not executable on win32') },
  () => {
    it('status looks at <vault>/.vault-search/watch.pid, not <pluginData>/watch.pid', () => {
      const pluginData = mkdtempSync(join(tmpdir(), 'll-pd-'));
      const vault = mkdtempSync(join(tmpdir(), 'll-vault-'));
      try {
        mkdirSync(join(vault, '.vault-search'), { recursive: true });
        mkdirSync(join(pluginData, 'bin'), { recursive: true });
        const fakeBin = join(pluginData, 'bin', 'll-search');
        writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n');
        chmodSync(fakeBin, 0o755);
        // Write an alive PID to the LEGACY path. If watch.mjs still reads the
        // legacy path, process.kill(alivePid, 0) succeeds and `status` exits 0
        // printing "Running". After the fix it must read <vault>/.vault-search/watch.pid
        // (which does not exist) and return "Not running" with exit code 1.
        writeFileSync(join(pluginData, 'watch.pid'), String(process.pid));
        writeFileSync(join(pluginData, 'config.json'), JSON.stringify({ vault_path: vault }));
        const r = spawnSync('node', [SCRIPT, 'status'], {
          encoding: 'utf-8',
          timeout: 5000,
          env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
        });
        assert.equal(r.status, 1, `stderr: ${r.stderr}`);
        assert.match(r.stdout, /^Not running/m);
      } finally {
        rmSync(pluginData, { recursive: true, force: true });
        rmSync(vault, { recursive: true, force: true });
      }
    });
  },
);
