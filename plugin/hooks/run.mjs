#!/usr/bin/env node
// hooks/run.mjs <hooks/name.js> : the entry point of every hooks.json command.
//
// Claude Code pins an open session to the version directory it loaded, so a
// hook named by path keeps running that version's code until the session
// reloads. This runs the named hook from the install Claude Code has active
// instead (plugin-meta.mjs activeRoot), so a release reaches every open session
// on its next hook call. argv[1] becomes the hook's own path because hookName()
// reads it for the hooks.disabled gate.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { activeRoot } from '../scripts/lib/plugin-meta.mjs';

const hook = process.argv[2];
if (!hook) {
  console.error('usage: run.mjs <hooks/name.js>');
  process.exit(1);
}
const target = join(activeRoot({ need: hook }), hook);
process.argv.splice(1, 2, target);
await import(pathToFileURL(target).href);
