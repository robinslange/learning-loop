import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmpPluginData = mkdtempSync(join(tmpdir(), 'll-snap-race-pd-'));
const tmpVault = mkdtempSync(join(tmpdir(), 'll-snap-race-vault-'));

process.env.CLAUDE_PLUGIN_DATA = tmpPluginData;

mkdirSync(join(tmpVault, '0-inbox'), { recursive: true });
writeFileSync(join(tmpVault, '0-inbox', 'seed.md'), 'seed\n');

const snapshotPath = join(tmpPluginData, 'vault-snapshot.json');
const snapshotMjsPath = fileURLToPath(new URL('../hooks/lib/snapshot.mjs', import.meta.url));

const mod = await import('../hooks/lib/snapshot.mjs');
const { rebuildVaultSnapshot } = mod;

rebuildVaultSnapshot(tmpVault);

function runWorker(relPath) {
  return new Promise((resolve, reject) => {
    const code = `
import { loadVaultSnapshot, maybeSplice } from ${JSON.stringify(snapshotMjsPath)};
const snap = loadVaultSnapshot(${JSON.stringify(tmpVault)});
maybeSplice(snap, {
  folder: '0-inbox',
  basename: ${JSON.stringify(relPath.replace('0-inbox/', '').replace('.md', ''))},
  rel_path: ${JSON.stringify(relPath)},
});
`;
    const child = spawn(process.execPath, ['--input-type=module'], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: tmpPluginData },
    });
    const stderr = [];
    child.stderr.on('data', (d) => stderr.push(d));
    child.stdin.end(code);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`Worker failed: ${Buffer.concat(stderr).toString()}`));
      else resolve();
    });
  });
}

test('concurrent splices from two child processes both persist to disk', async () => {
  await Promise.all([runWorker('0-inbox/race-alpha.md'), runWorker('0-inbox/race-beta.md')]);

  const onDisk = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
  const relPaths = onDisk.notes.map((n) => n.rel_path);
  assert.ok(relPaths.includes('0-inbox/race-alpha.md'), 'race-alpha missing from snapshot');
  assert.ok(relPaths.includes('0-inbox/race-beta.md'), 'race-beta missing from snapshot');
});

test('cleanup race temp dirs', () => {
  rmSync(tmpVault, { recursive: true, force: true });
  rmSync(tmpPluginData, { recursive: true, force: true });
});
