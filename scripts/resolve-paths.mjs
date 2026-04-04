#!/usr/bin/env node
// Outputs PLUGIN, PLUGIN_DATA, and VAULT as JSON for skill consumption.
// Skills instruct the LLM to run this before any path-dependent operation.

import { getPluginRoot, getPluginData, getVaultPath } from './lib/config.mjs';

console.log(JSON.stringify({
  PLUGIN: getPluginRoot(),
  PLUGIN_DATA: getPluginData(),
  VAULT: getVaultPath()
}));
