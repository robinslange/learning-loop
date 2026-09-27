#!/usr/bin/env node
// bench/mutation.mjs : run the Stryker targets in bench/mutation-targets.mjs.
//
// Usage: node bench/mutation.mjs [target ...]   (default: every target)
//
// Every target runs even after an earlier one broke its threshold, so one
// failure can't hide another. Exits 1 if any target broke or failed to run.

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TARGETS } from './mutation-targets.mjs';

const root = join(import.meta.dirname, '..');
const stryker = join(root, 'node_modules', '@stryker-mutator', 'core', 'bin', 'stryker.js');

const names = process.argv.slice(2);
const unknown = names.filter((n) => !Object.hasOwn(TARGETS, n));
if (unknown.length > 0) {
  console.error(
    `unknown target(s): ${unknown.join(', ')}; known: ${Object.keys(TARGETS).join(', ')}`,
  );
  process.exit(2);
}

function score(name) {
  try {
    const report = JSON.parse(
      readFileSync(join(root, 'reports', 'mutation', `${name}.json`), 'utf8'),
    );
    const mutants = Object.values(report.files).flatMap((f) => f.mutants);
    const killed = mutants.filter((m) => m.status === 'Killed' || m.status === 'Timeout').length;
    const valid = mutants.filter(
      (m) => !['CompileError', 'RuntimeError', 'Ignored'].includes(m.status),
    );
    return valid.length === 0 ? null : (100 * killed) / valid.length;
  } catch {
    return null;
  }
}

const results = [];
for (const name of names.length > 0 ? names : Object.keys(TARGETS)) {
  console.log(`\n=== ${name}`);
  rmSync(join(root, 'reports', 'mutation', `${name}.json`), { force: true });
  const started = Date.now();
  const r = spawnSync(process.execPath, [stryker, 'run'], {
    cwd: root,
    env: { ...process.env, LL_MUTATE: name },
    stdio: 'inherit',
  });
  results.push({
    name,
    ok: r.status === 0,
    score: score(name),
    min: Math.round((Date.now() - started) / 60000),
  });
}

console.log('\ntarget              score   break  minutes  result');
for (const { name, ok, score: s, min } of results) {
  const shown = s === null ? '   -  ' : s.toFixed(2).padStart(6);
  console.log(
    `${name.padEnd(18)} ${shown}  ${String(TARGETS[name].break).padStart(5)}  ${String(min).padStart(7)}  ${ok ? 'ok' : 'BROKE'}`,
  );
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
