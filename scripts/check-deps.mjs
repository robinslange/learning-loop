#!/usr/bin/env node
// Checks plugin dependencies declared in config.json against installed_plugins.json.
// Returns JSON: { "plugin-name": { status, installed, required, marketplace, reason } }

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const PLUGIN_DIR = resolve(import.meta.dirname, '..');
const CONFIG_PATH = join(PLUGIN_DIR, 'config.json');
const INSTALLED_PATH = join(
  process.env.HOME || process.env.USERPROFILE || homedir(),
  '.claude', 'plugins', 'installed_plugins.json'
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

let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
} catch {
  process.stdout.write('{}');
  process.exit(0);
}

const deps = config.dependencies || [];
if (deps.length === 0) {
  process.stdout.write('{}');
  process.exit(0);
}

let installed;
try {
  const raw = JSON.parse(readFileSync(INSTALLED_PATH, 'utf-8'));
  installed = raw.plugins || raw;
} catch {
  installed = {};
}

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
