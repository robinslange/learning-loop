#!/usr/bin/env node
// Checks plugin dependencies declared in config.json against installed_plugins.json.
// Returns JSON: { "plugin-name": { status, installed, required, marketplace, reason } }

import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { env } from './lib/env.mjs';
import { logError } from './lib/log.mjs';
import { safeLoad } from './lib/safe-load.mjs';

const PLUGIN_DIR = resolve(import.meta.dirname, '..');
const CONFIG_PATH = join(PLUGIN_DIR, 'config.json');
const INSTALLED_PATH = join(
  env.HOME || env.USERPROFILE || homedir(),
  '.claude',
  'plugins',
  'installed_plugins.json',
);

function satisfiesVersion(installed, constraint) {
  if (!constraint || !installed) return true;
  const match = constraint.match(/^>=\s*(\d+\.\d+\.\d+)$/);
  if (!match) return true;
  const [reqMajor, reqMinor, reqPatch] = match[1].split('.').map(Number);
  const [insMajor, insMinor, insPatch] = installed.split('.').map(Number);
  if (insMajor !== reqMajor) return insMajor > reqMajor;
  if (insMinor !== reqMinor) return insMinor > reqMinor;
  return insPatch >= reqPatch;
}

const { value: config, error: configError } = safeLoad(CONFIG_PATH, { fallback: null });
if (configError || !config) {
  process.stdout.write('{}');
  process.exit(0);
}

const deps = config.dependencies || [];
if (deps.length === 0) {
  process.stdout.write('{}');
  process.exit(0);
}

const { value: rawInstalled } = safeLoad(INSTALLED_PATH, { fallback: {} });
const installed = rawInstalled?.plugins || rawInstalled || {};

const result = {};

for (const dep of deps) {
  const key = `${dep.name}@${dep.marketplace}`;
  const entries = installed[key];

  if (!entries || entries.length === 0) {
    result[dep.name] = {
      status: 'missing',
      installed: null,
      required: dep.version || null,
      marketplace: dep.marketplace,
      reason: dep.reason || null,
      tools: dep.tools || [],
    };
    continue;
  }

  const entry = entries[0];
  const version = entry.version || 'unknown';

  if (!satisfiesVersion(version, dep.version)) {
    result[dep.name] = {
      status: 'outdated',
      installed: version,
      required: dep.version,
      marketplace: dep.marketplace,
      reason: dep.reason || null,
      tools: dep.tools || [],
    };
    continue;
  }

  result[dep.name] = {
    status: 'installed',
    installed: version,
    required: dep.version || null,
    marketplace: dep.marketplace,
    reason: dep.reason || null,
    tools: dep.tools || [],
  };
}

process.stdout.write(JSON.stringify(result));
