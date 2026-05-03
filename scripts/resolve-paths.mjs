#!/usr/bin/env node
// Outputs PLUGIN, PLUGIN_DATA, and VAULT as JSON, or a single field as a bare
// string if invoked with one of those names as an argument. Skills shell to
// this rather than hardcoding the marketplace-name plugin-data fallback.

import { getPluginRoot, getPluginData, getVaultPath } from './lib/config.mjs';

const fields = {
  PLUGIN: getPluginRoot(),
  PLUGIN_DATA: getPluginData(),
  VAULT: getVaultPath(),
};

const arg = process.argv[2];
if (arg && Object.hasOwn(fields, arg)) {
  console.log(fields[arg] ?? '');
} else {
  console.log(JSON.stringify(fields));
}
