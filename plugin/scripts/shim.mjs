#!/usr/bin/env node
// scripts/shim.mjs <shim> [args...] : what ll-run, ll-paths and ll-watch do.
//
// Those shims only locate the active install and hand off here
// (scripts/lib/shims.mjs), so a change to any of these ships with the plugin
// instead of waiting for someone to reinstall the shims. ll-search is not here:
// it is a node-free shell shim, because node startup would triple its cost.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { spawnEnv } from './lib/env.mjs';

const ROOT = join(import.meta.dirname, '..');

// In-process with argv shaped as if node had been given the script directly:
// one node startup, stdin untouched, and main-module guards still match.
async function runNode(script, args) {
  process.argv = [process.argv[0], script, ...args];
  await import(pathToFileURL(script).href);
}

function exec(command, args, childEnv) {
  const r = spawnSync(command, args, { stdio: 'inherit', env: childEnv });
  process.exit(r.status ?? 1);
}

const SHIMS = {
  'll-paths': (args) => runNode(join(ROOT, 'scripts', 'resolve-paths.mjs'), args),
  'll-watch': (args) => runNode(join(ROOT, 'scripts', 'watch.mjs'), args),
  'll-run': ([script, ...args]) => {
    if (!script) {
      console.error('usage: ll-run <script> [args...]');
      process.exit(2);
    }
    const path = ['scripts', 'bin']
      .map((dir) => join(ROOT, dir, script))
      .find((p) => existsSync(p));
    if (!path) {
      console.error(
        `error: no such learning-loop script: ${script}\n  Looked in: scripts/ and bin/ under ${ROOT}`,
      );
      process.exit(2);
    }
    if (path.endsWith('.sh')) exec('bash', [path, ...args], spawnEnv({}));
    return runNode(path, args);
  },
};

const [name, ...args] = process.argv.slice(2);
await SHIMS[name](args);
