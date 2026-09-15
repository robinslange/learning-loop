#!/usr/bin/env node
// Installs ~/.local/bin shims for the learning-loop CLIs.
//
// Usage:
//   node install-shims.mjs                  -- install all shims (default)
//   node install-shims.mjs --install        -- same (compat alias)
//   node install-shims.mjs --check          -- print which shims exist, exit 0
//
// ll-watch, ll-search, ll-paths and ll-run (text in scripts/lib/shims.mjs).
// ll-watch, ll-paths and ll-run find the active install and run its
// scripts/shim.mjs, so new behaviour arrives without rewriting them. ll-search
// runs the plugin-data binary directly and never starts node. ll-paths and ll-run exist because ${CLAUDE_PLUGIN_ROOT} is
// substituted only into a SKILL.md: a Bash block anywhere else needs a command
// on PATH. SessionStart rewrites any shim whose text differs from what the
// running version renders.

import { writeFileSync, mkdirSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getPluginData } from './lib/config.mjs';
import { env } from './lib/env.mjs';
import { SHIM_NAMES, shimFileName } from './lib/paths.mjs';
import { renderShim } from './lib/shims.mjs';
import { migrateRetrievalLogsIfNeeded } from './lib/migrate-retrieval-logs.mjs';

const isWindows = process.platform === 'win32';
const command = process.argv[2] || '--install';

const binDir = join(homedir(), '.local', 'bin');

// One list, in scripts/lib/paths.mjs, shared with the health check and the
// SessionStart hook that decides whether to re-run this installer.
const shimPath = (name) => join(binDir, shimFileName(name));
const llWatchPath = shimPath('ll-watch');
const llSearchPath = shimPath('ll-search');
const llPathsPath = shimPath('ll-paths');
const llRunPath = shimPath('ll-run');

if (command === '--check' || command === 'check') {
  const w = existsSync(llWatchPath) ? 'installed' : 'missing';
  const s = existsSync(llSearchPath) ? 'installed' : 'missing';
  const p = existsSync(llPathsPath) ? 'installed' : 'missing';
  const r = existsSync(llRunPath) ? 'installed' : 'missing';
  console.log(`ll-watch:  ${w} (${llWatchPath})`);
  console.log(`ll-search: ${s} (${llSearchPath})`);
  console.log(`ll-paths:  ${p} (${llPathsPath})`);
  console.log(`ll-run:    ${r} (${llRunPath})`);
  process.exit(0);
}

if (command !== '--install' && command !== 'install') {
  console.error(`unknown command: ${command}`);
  console.error('usage: install-shims.mjs [--install|--check]');
  process.exit(2);
}

mkdirSync(binDir, { recursive: true });

for (const name of SHIM_NAMES) {
  writeFileSync(shimPath(name), renderShim(name));
  if (!isWindows) chmodSync(shimPath(name), 0o755);
  console.log(`Wrote ${shimPath(name)}`);
}
console.log('Each shim runs the active plugin install, so it survives plugin updates.');

if (isWindows) {
  console.log(`\nNOTE: cmd.exe does not add %USERPROFILE%\\.local\\bin to PATH automatically.`);
  console.log(
    `Add it via: setx PATH "%USERPROFILE%\\.local\\bin;%PATH%" (run in cmd.exe, then restart terminal)`,
  );
} else {
  // One-shot cleanup of pre-canonical retrieval logs. Mixing the old
  // passthrough/inline shapes with the new canonical shape would muddy
  // downstream analytics. Marked complete by a sentinel file in plugin-data.
  const pd = getPluginData();
  if (pd) {
    const result = migrateRetrievalLogsIfNeeded(pd);
    if (!result.skipped) {
      console.log(
        `Migrated retrieval logs: removed ${result.removed} pre-canonical .jsonl file(s)`,
      );
    }
  }

  const pathDirs = (env.PATH || '').split(':');
  if (!pathDirs.includes(binDir)) {
    console.log(`\nAdd to your shell rc:  export PATH="$HOME/.local/bin:$PATH"`);
  }
}
