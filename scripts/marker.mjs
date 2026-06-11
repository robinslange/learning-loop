#!/usr/bin/env node
// scripts/marker.mjs — skill-facing CLI for the dream/reflect marker handshake.
// Skills shell here instead of hand-rolling tmpdir() one-liners (the M1/M2
// split-brain: skill bash inherits $TMPDIR, hook subprocesses don't). Every
// write routes through writeMarker, which carries the pluginDataExists()
// resurrection guard.
//
//   stamp <last-dream|last-reflect>   write epoch seconds; prints the path
//   lock-acquire dream                exit 0 = acquired; exit 1 = held
//   lock-release dream                remove the lock (idempotent)
//   path <key>                        print the resolved path for any key
//
// Exit codes: 1 means EXCLUSIVELY "lock held" — skills abort on it as
// "another /dream is running". Usage errors and unresolved plugin-data
// exit 2 so a typo never reads as a false "already running".
//
// lock-acquire is check-then-write, not O_EXCL: two simultaneous /dream runs
// can both acquire. Same accepted-risk class as dream-gate's documented
// first-run race — the lock's job is crash recovery, not mutual exclusion.

import { rmSync } from 'node:fs';
import { getPluginData, pluginDataExists } from './lib/config.mjs';
import { MARKER_PATHS, writeMarker, dreamLockHeld } from './lib/marker-cache.mjs';

const KEY_MAP = {
  'last-dream': 'lastDream',
  'last-reflect': 'lastReflect',
  'dream-lock': 'dreamLock',
  'dream-nudged': 'dreamNudged',
};

function usage() {
  process.stderr.write(
    'usage: marker.mjs stamp <last-dream|last-reflect> | lock-acquire dream | lock-release dream | path <key>\n',
  );
  process.exit(2);
}

const [cmd, name] = process.argv.slice(2);
const pluginData = getPluginData();
if (!pluginData) {
  process.stderr.write('marker: plugin-data unresolved\n');
  process.exit(2);
}

function pathFor(key) {
  const fn = KEY_MAP[key] && MARKER_PATHS[KEY_MAP[key]];
  if (!fn) usage();
  return fn(pluginData);
}

if (cmd === 'stamp' && (name === 'last-dream' || name === 'last-reflect')) {
  const p = pathFor(name);
  if (!pluginDataExists()) process.stderr.write('marker: plugin-data missing — stamp skipped\n');
  writeMarker(p, Math.floor(Date.now() / 1000));
  console.log(p);
} else if (cmd === 'lock-acquire' && name === 'dream') {
  const p = pathFor('dream-lock');
  if (dreamLockHeld(p)) {
    process.stderr.write(`marker: dream lock held (${p}) — another /dream is running or crashed <1h ago\n`);
    process.exit(1);
  }
  // No pid in new lock content: the CLI's ppid is the per-call bash, which
  // dies seconds later; a reused pid on a long-lived process would make
  // dreamLockHeld's pid-alive branch (no age cap) hold the lock forever.
  // Staleness is decided by the 1h age floor alone. The pid-alive branch in
  // dreamLockHeld remains for legacy bare-pid lock files only.
  writeMarker(p, { ts: Math.floor(Date.now() / 1000) });
  console.log(p);
} else if (cmd === 'lock-release' && name === 'dream') {
  rmSync(pathFor('dream-lock'), { force: true });
} else if (cmd === 'path' && name) {
  console.log(pathFor(name));
} else {
  usage();
}
