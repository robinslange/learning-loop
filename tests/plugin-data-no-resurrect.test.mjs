// tests/plugin-data-no-resurrect.test.mjs
// Pins "never resurrect a deleted plugin-data" across every writer reachable
// from session-start's DETACHED children (provenance emitter, intentions
// refresh worker, dream-gate). Under suite load those children can finish
// after the test harness rmSync'd their sandbox; an unguarded recursive mkdir
// re-creates the sandbox root (the ll-hook-sb-* leak of 2026-06). Writers may
// create SUBdirs, but must no-op when the plugin-data ROOT is gone.

import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const EMITTER = join(SCRIPTS, 'provenance.mjs');
const MARKER_CACHE_URL = pathToFileURL(join(SCRIPTS, 'lib', 'marker-cache.mjs')).href;
const CONFIG_URL = pathToFileURL(join(SCRIPTS, 'lib', 'config.mjs')).href;

// migrateConfig only fires when the legacy repo-root config.json exists; it is
// gitignored (real user config), so skip those tests on checkouts without it.
const LEGACY_CONFIG = join(SCRIPTS, '..', 'config.json');
const NO_LEGACY = !existsSync(LEGACY_CONFIG)
  && 'repo-root config.json (gitignored) absent — legacy migration cannot fire';

function runModule(code, pluginData) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
    encoding: 'utf-8',
  });
}

function goneDir(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  rmSync(root, { recursive: true, force: true });
  return root;
}

// --- provenance emitter (CLI spawned detached by context-assembly) ---

function emit(pluginData) {
  return spawnSync(process.execPath, [EMITTER, JSON.stringify({ agent: 'test', action: 'no-resurrect' })], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
    encoding: 'utf-8',
  });
}

test('emitProvenance does not re-create a deleted plugin-data dir', () => {
  const root = goneDir('ll-prov-gone-');
  const result = emit(root);
  assert.equal(result.status, 0, `emitter must no-op cleanly, stderr: ${result.stderr}`);
  assert.ok(!existsSync(root), 'deleted plugin-data must not be resurrected');
});

test('emitProvenance still appends when plugin-data exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-prov-live-'));
  try {
    const result = emit(root);
    assert.equal(result.status, 0, `emitter must succeed, stderr: ${result.stderr}`);
    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const eventsFile = join(root, 'provenance', `events-${month}.jsonl`);
    assert.ok(existsSync(eventsFile), 'events file must be written');
    assert.match(readFileSync(eventsFile, 'utf-8'), /"action":"no-resurrect"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- writeMarker (intentions worker, dream-gate — both spawned detached) ---

const WRITE_MARKER_CODE = `
import { writeMarker, MARKER_PATHS } from ${JSON.stringify(MARKER_CACHE_URL)};
writeMarker(MARKER_PATHS.intentions(process.env.CLAUDE_PLUGIN_DATA), { nudge: null });
`;

test('writeMarker does not re-create a deleted plugin-data dir', () => {
  const root = goneDir('ll-marker-gone-');
  const result = runModule(WRITE_MARKER_CODE, root);
  assert.equal(result.status, 0, `writeMarker must no-op cleanly, stderr: ${result.stderr}`);
  assert.ok(!existsSync(root), 'deleted plugin-data must not be resurrected');
});

test('writeMarker still writes when plugin-data exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-marker-live-'));
  try {
    const result = runModule(WRITE_MARKER_CODE, root);
    assert.equal(result.status, 0, `writeMarker must succeed, stderr: ${result.stderr}`);
    const marker = join(root, 'session-start-cache', 'intentions.json');
    assert.ok(existsSync(marker), 'marker must be written under an existing root');
    assert.match(readFileSync(marker, 'utf-8'), /"nudge":null/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- migrateConfig (fires inside getConfig() in any detached worker) ---

const GET_CONFIG_CODE = `
import { getConfig } from ${JSON.stringify(CONFIG_URL)};
getConfig();
`;

test('getConfig legacy migration does not re-create a deleted plugin-data dir', { skip: NO_LEGACY }, () => {
  const root = goneDir('ll-config-gone-');
  const result = runModule(GET_CONFIG_CODE, root);
  assert.equal(result.status, 0, `getConfig must no-op cleanly, stderr: ${result.stderr}`);
  assert.ok(!existsSync(root), 'deleted plugin-data must not be resurrected');
});

test('getConfig legacy migration still writes when plugin-data exists', { skip: NO_LEGACY }, () => {
  const root = mkdtempSync(join(tmpdir(), 'll-config-live-'));
  try {
    const result = runModule(GET_CONFIG_CODE, root);
    assert.equal(result.status, 0, `getConfig must succeed, stderr: ${result.stderr}`);
    assert.ok(existsSync(join(root, 'config.json')), 'legacy config must migrate into an existing root');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- scripts/marker.mjs (skill-facing CLI; runs in live sessions, but pin
// --- the guard anyway: a deleted plugin-data must never be resurrected) ---

const MARKER_CLI = join(SCRIPTS, 'marker.mjs');

function markerCli(args, pluginData) {
  return spawnSync(process.execPath, [MARKER_CLI, ...args], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
    encoding: 'utf-8',
  });
}

test('marker.mjs stamp does not re-create a deleted plugin-data dir', () => {
  const root = goneDir('ll-mcli-gone-');
  const result = markerCli(['stamp', 'last-reflect'], root);
  assert.equal(result.status, 0, `stamp must no-op cleanly, stderr: ${result.stderr}`);
  assert.ok(!existsSync(root), 'deleted plugin-data must not be resurrected');
});

test('marker.mjs lock-acquire does not re-create a deleted plugin-data dir', () => {
  const root = goneDir('ll-mcli-lock-gone-');
  const result = markerCli(['lock-acquire', 'dream'], root);
  assert.equal(result.status, 0, `lock-acquire must no-op cleanly, stderr: ${result.stderr}`);
  assert.ok(!existsSync(root), 'deleted plugin-data must not be resurrected');
});

// --- dream-gate first-run write (spawned detached by context-assembly) ---

const DREAM_GATE = join(SCRIPTS, '..', 'hooks', 'lib', 'dream-gate.js');

test('dream-gate first-run stamp does not re-create a deleted plugin-data dir', () => {
  const root = goneDir('ll-dg-gone-');
  const result = spawnSync(process.execPath, [DREAM_GATE], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: root },
    encoding: 'utf-8',
  });
  assert.equal(result.status, 0, `dream-gate must no-op cleanly, stderr: ${result.stderr}`);
  assert.ok(!existsSync(root), 'deleted plugin-data must not be resurrected');
});

// --- hooks/lib/common.mjs TWIN emitProvenance (same name as the guarded
// --- scripts/provenance.mjs emitter; unguarded recursive mkdir reopens the
// --- resurrection class if ever called from a detached worker) ---

const COMMON_URL = pathToFileURL(join(SCRIPTS, '..', 'hooks', 'lib', 'common.mjs')).href;

const HOOK_EMIT_CODE = `
import { emitProvenance } from ${JSON.stringify(COMMON_URL)};
emitProvenance({ path: 'x.md', agent_id: 'no-resurrect' });
`;

test('hooks/lib/common.mjs emitProvenance does not re-create a deleted plugin-data dir', () => {
  const root = goneDir('ll-hookprov-gone-');
  const result = runModule(HOOK_EMIT_CODE, root);
  assert.equal(result.status, 0, `hook emitProvenance must no-op cleanly, stderr: ${result.stderr}`);
  assert.ok(!existsSync(root), 'deleted plugin-data must not be resurrected');
});

test('hooks/lib/common.mjs emitProvenance still appends when plugin-data exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-hookprov-live-'));
  try {
    const result = runModule(HOOK_EMIT_CODE, root);
    assert.equal(result.status, 0, result.stderr);
    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    assert.ok(existsSync(join(root, 'provenance', `events-${month}.jsonl`)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
