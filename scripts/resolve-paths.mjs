#!/usr/bin/env node
// Outputs PLUGIN, PLUGIN_DATA, and VAULT as JSON, or a single field as a bare
// string if invoked with one of those names as an argument. Skills shell to
// this rather than hardcoding the marketplace-name plugin-data fallback.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPluginRoot, getPluginData, getVaultPath } from './lib/config.mjs';
import { getSessionId } from './lib/session.mjs';
import { DATA_PATHS } from './lib/paths.mjs';

const pluginData = getPluginData();

const fields = {
  PLUGIN: getPluginRoot(),
  PLUGIN_DATA: pluginData,
  VAULT: getVaultPath(),
  // The canonical session id (scripts/lib/session.mjs) the reflect new-notes
  // hook keys its marker on. Skills resolve LL_SID through this so both sides
  // of the handshake run the identical resolver.
  SESSION_ID: getSessionId(),
  // The dir the reflect Step 4 scratch markers live in — plugin-data, NOT tmp.
  // Mirrors hooks/modules/reflect-track.mjs:reflectScratchDir() exactly so the
  // skill's bash and the hook resolve the same dir even when one inherits
  // $TMPDIR and the other doesn't (os.tmpdir() honors $TMPDIR; plugin-data
  // doesn't, so it agrees across the hook/shell process boundary).
  REFLECT_SCRATCH: pluginData ? DATA_PATHS.reflectScratch(pluginData) : tmpdir(),
};

const arg = process.argv[2];
if (arg && Object.hasOwn(fields, arg)) {
  console.log(fields[arg] ?? '');
} else {
  console.log(JSON.stringify(fields));
}
