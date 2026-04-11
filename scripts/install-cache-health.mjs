#!/usr/bin/env node
// install-cache-health.mjs — Install the cache-health oh-my-claude plugin.
//
// Idempotent. Detects oh-my-claude installation, copies the plugin file,
// and enables it in the omc config. Safe to re-run.
//
// Usage:
//   node scripts/install-cache-health.mjs             # install
//   node scripts/install-cache-health.mjs --check     # detect only, no changes
//   node scripts/install-cache-health.mjs --uninstall # remove
//
// Exit codes:
//   0 — success (or already installed)
//   1 — oh-my-claude not found
//   2 — error during install

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, rmSync, lstatSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, '..');
const SOURCE = join(PLUGIN_ROOT, 'plugins', 'omc-cache-health', 'plugin.js');

const OMC_ROOT = join(homedir(), '.claude', 'oh-my-claude');
const OMC_PLUGINS_DIR = join(OMC_ROOT, 'plugins');
const OMC_CONFIG = join(OMC_ROOT, 'config.json');
const OMC_TARGET_DIR = join(OMC_PLUGINS_DIR, 'cache-health');
const OMC_TARGET = join(OMC_TARGET_DIR, 'plugin.js');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const uninstall = args.includes('--uninstall');

function detect() {
  return {
    omc_installed: existsSync(OMC_ROOT),
    omc_config_exists: existsSync(OMC_CONFIG),
    source_exists: existsSync(SOURCE),
    plugin_file_installed: existsSync(OMC_TARGET),
  };
}

function readConfig() {
  if (!existsSync(OMC_CONFIG)) return null;
  try { return JSON.parse(readFileSync(OMC_CONFIG, 'utf8')); }
  catch { return null; }
}

function isConfigured(cfg) {
  if (!cfg) return false;
  const inLines = (cfg.lines || []).some(line =>
    ['left', 'right', 'center'].some(pos => (line[pos] || []).includes('cache-health'))
  );
  const hasConfig = cfg.plugins?.['cache-health'] != null;
  return inLines && hasConfig;
}

function isDevSymlink() {
  try { return lstatSync(OMC_TARGET_DIR).isSymbolicLink(); }
  catch { return false; }
}

function installPluginFile() {
  if (isDevSymlink()) return 'dev-symlink';
  try { mkdirSync(OMC_TARGET_DIR, { recursive: true }); } catch {}
  copyFileSync(SOURCE, OMC_TARGET);
  return 'copied';
}

function updateConfig() {
  const raw = readFileSync(OMC_CONFIG, 'utf8');
  const cfg = JSON.parse(raw);

  let changed = false;

  // Insert cache-health in the first line's left column, after context-percent if present
  cfg.lines = cfg.lines || [{ left: [] }];
  const firstLine = cfg.lines[0];
  firstLine.left = firstLine.left || [];
  if (!firstLine.left.includes('cache-health')) {
    const afterIdx = firstLine.left.indexOf('context-percent');
    const insertAt = afterIdx >= 0 ? afterIdx + 1 : firstLine.left.length;
    firstLine.left.splice(insertAt, 0, 'cache-health');
    changed = true;
  }

  // Add plugin config
  cfg.plugins = cfg.plugins || {};
  if (!cfg.plugins['cache-health']) {
    cfg.plugins['cache-health'] = {
      style: 'dim',
      warnAt: 70,
      criticalAt: 40,
      styleWarn: 'yellow',
      styleCritical: 'red',
    };
    changed = true;
  }

  if (changed) {
    writeFileSync(OMC_CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  }
  return changed;
}

function removeFromConfig() {
  if (!existsSync(OMC_CONFIG)) return false;
  const cfg = JSON.parse(readFileSync(OMC_CONFIG, 'utf8'));
  let changed = false;

  for (const line of cfg.lines || []) {
    for (const pos of ['left', 'right', 'center']) {
      if (!line[pos]) continue;
      const idx = line[pos].indexOf('cache-health');
      if (idx >= 0) {
        line[pos].splice(idx, 1);
        changed = true;
      }
    }
  }

  if (cfg.plugins?.['cache-health']) {
    delete cfg.plugins['cache-health'];
    changed = true;
  }

  if (changed) {
    writeFileSync(OMC_CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  }
  return changed;
}

// Main
const state = detect();

if (checkOnly) {
  const cfg = readConfig();
  console.log(JSON.stringify({
    ...state,
    configured: isConfigured(cfg),
    source_path: SOURCE,
    target_path: OMC_TARGET,
  }, null, 2));
  process.exit(0);
}

if (!state.source_exists) {
  console.error(`Source plugin not found at ${SOURCE}`);
  process.exit(2);
}

if (uninstall) {
  if (state.plugin_file_installed) {
    rmSync(OMC_TARGET_DIR, { recursive: true, force: true });
  }
  const removed = removeFromConfig();
  console.log(removed || state.plugin_file_installed ? 'cache-health uninstalled' : 'cache-health not installed');
  process.exit(0);
}

if (!state.omc_installed) {
  console.error('oh-my-claude not found at ~/.claude/oh-my-claude/');
  console.error('Install oh-my-claude first: https://github.com/npow/oh-my-claude');
  process.exit(1);
}

try {
  const fileResult = installPluginFile();
  const cfg = readConfig();
  if (cfg) {
    const changed = updateConfig();
    const fileNote = fileResult === 'dev-symlink' ? ' (dev symlink, file left alone)' : '';
    if (changed) console.log(`cache-health installed and enabled in oh-my-claude${fileNote}`);
    else console.log(`cache-health already configured${fileNote}`);
  } else {
    console.log('cache-health plugin copied (no omc config.json found, enable manually)');
  }
  process.exit(0);
} catch (err) {
  console.error(`install failed: ${err.message}`);
  process.exit(2);
}
