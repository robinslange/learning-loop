#!/usr/bin/env node
// Learning Loop — Stop hook background re-index
// Spawns a detached `ll-search index` so retrieval stays fresh between turns.
// Returns immediately. Lockfile prevents overlapping runs across turns/sessions.

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { resolveVaultPath, readStdin, findBinary } from './lib/common.mjs';

const LOCK_PATH = join(tmpdir(), 'learning-loop-reindex.lock');
const STALE_LOCK_MS = 10 * 60 * 1000;
const DEBUG = process.env.LL_REINDEX_DEBUG === '1';
const trace = (msg) => { if (DEBUG) process.stderr.write(`[reindex] ${msg}\n`); };

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isLockHeld() {
  if (!existsSync(LOCK_PATH)) return false;
  try {
    const raw = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
    const ageMs = Date.now() - (raw.ts || 0);
    if (raw.pid && isPidAlive(raw.pid) && ageMs < STALE_LOCK_MS) return true;
  } catch {}
  try { unlinkSync(LOCK_PATH); } catch {}
  return false;
}

function writeLock(childPid) {
  writeFileSync(LOCK_PATH, JSON.stringify({ pid: childPid, ts: Date.now() }));
}

const input = await readStdin();
trace(`input bytes=${input.length}`);
if (!input.trim()) { trace('exit: empty input'); process.exit(0); }

let hookData;
try { hookData = JSON.parse(input); } catch { trace('exit: parse error'); process.exit(0); }
if (hookData.stop_hook_active) { trace('exit: stop_hook_active'); process.exit(0); }

const vaultRoot = resolveVaultPath();
if (!vaultRoot) { trace('exit: no vault'); process.exit(0); }

const binary = findBinary();
if (!binary) { trace('exit: no binary'); process.exit(0); }

const dbPath = join(vaultRoot, '.vault-search', 'vault-index.db');
if (!existsSync(dbPath)) { trace(`exit: no db at ${dbPath}`); process.exit(0); }

if (isLockHeld()) { trace('exit: lock held'); process.exit(0); }

const child = spawn(binary.bin, ['index', vaultRoot, dbPath], {
  detached: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    ORT_DYLIB_PATH: binary.binDir,
    ORT_LIB_LOCATION: binary.binDir,
    LL_REINDEX_TS: String(Date.now()),
  },
});
trace(`spawned pid=${child.pid}`);
writeLock(child.pid);
child.unref();

process.exit(0);
