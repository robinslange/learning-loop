#!/usr/bin/env node
// scripts/check-deps.mjs — plugin dependency reporter.
// Thinned to a wrapper over check-deps-impl.mjs. Emits the same JSON shape
// it always has so external callers (e.g. session-start hook, init Phase 3)
// keep working.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { env } from './lib/env.mjs';
import { safeLoad } from './lib/safe-load.mjs';
import { getConfig } from './lib/config.mjs';
import { buildAbiDrift, satisfiesVersion } from './check-deps-impl.mjs';
import { pathToFileURL } from 'node:url';

export { detectAbiDrift } from './check-deps-impl.mjs';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const INSTALLED_PATH = join(
    env.HOME || env.USERPROFILE || homedir(),
    '.claude',
    'plugins',
    'installed_plugins.json',
  );

  const deps = getConfig().dependencies || [];
  if (deps.length === 0) {
    process.stdout.write(JSON.stringify({ _abi_drift: buildAbiDrift() }));
    process.exit(0);
  }

  const { value: rawInstalled } = safeLoad(INSTALLED_PATH, { fallback: {} });
  const installed = rawInstalled?.plugins || rawInstalled || {};

  const result = {};

  for (const dep of deps) {
    const key = `${dep.name}@${dep.marketplace}`;
    const entries = installed[key];
    const base = {
      versionConstraint: dep.version || null,
      marketplace: dep.marketplace,
      reason: dep.reason || null,
      required: !!dep.required,
      tools: dep.tools || [],
    };

    if (!entries || entries.length === 0) {
      result[dep.name] = { status: 'missing', installed: null, ...base };
      continue;
    }

    const entry = entries[0];
    const version = entry.version || 'unknown';

    if (!satisfiesVersion(version, dep.version)) {
      result[dep.name] = { status: 'outdated', installed: version, ...base };
      continue;
    }

    result[dep.name] = { status: 'installed', installed: version, ...base };
  }

  process.stdout.write(JSON.stringify({ ...result, _abi_drift: buildAbiDrift() }));
}
