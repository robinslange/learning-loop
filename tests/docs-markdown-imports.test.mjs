// tests/docs-markdown-imports.test.mjs : every `import(<plugin>/scripts/X).then(m
// => m.name)` a skill or agent tells Claude to run must name a real export of
// X (GitHub issue #101).
//
// Markdown is a caller no dead-code grep over JS can see: the health skill
// kept calling binary.mjs's binaryVersion() after a cleanup deleted it as
// callerless, and the step threw every time it ran. This test is the
// markdown half of that search.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PLUGIN = join(import.meta.dirname, '..', 'plugin');
const SCAN_DIRS = ['skills', 'agents', 'skills-shared', 'agents-shared'];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return extname(p) === '.md' ? [p] : [];
  });
}

// The module path, then the callback body up to the end of its paragraph, its
// code fence or the next plugin import, so a call continued over `\` lines
// still counts and two imports in one fence stay apart.
const PLUGIN_IMPORT = String.raw`import\(\s*(?:process\.argv\[1\]\s*\+\s*'|'\$PLUGIN)`;
const IMPORT_RE = new RegExp(
  String.raw`${PLUGIN_IMPORT}(\/scripts\/[^']+\.mjs)'\s*\)\.then\(\s*(?:async\s+)?\(?m\)?\s*=>([\s\S]*?)(?=\n\s*\n|${'```'}|${PLUGIN_IMPORT}|$)`,
  'g',
);

// Each use is the whole property chain, so m.DATA_FILES.harvestDenylist checks
// harvestDenylist too, not only DATA_FILES.
function callSites() {
  const sites = [];
  for (const file of SCAN_DIRS.flatMap((d) => walk(join(PLUGIN, d)))) {
    for (const [, modulePath, body] of readFileSync(file, 'utf-8').matchAll(IMPORT_RE)) {
      for (const [, chain] of body.matchAll(/\bm\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g)) {
        sites.push({
          file: relative(PLUGIN, file),
          modulePath,
          url: pathToFileURL(join(PLUGIN, modulePath)).href,
          chain,
        });
      }
    }
  }
  return sites;
}

// Resolved in a child with a throwaway HOME and plugin data, because some of
// these modules resolve paths from the environment when they load. Prints the
// sites whose chain comes out undefined.
function unresolved(sites) {
  const root = mkdtempSync(join(tmpdir(), 'll-md-imports-'));
  try {
    const script = `
      const missing = [];
      for (const s of ${JSON.stringify(sites)}) {
        let v = await import(s.url);
        for (const key of s.chain.split('.')) v = v?.[key];
        if (v === undefined) missing.push(s.file + ': ' + s.modulePath + ' has no ' + s.chain);
      }
      console.log(JSON.stringify(missing));
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, CLAUDE_PLUGIN_DATA: root },
      encoding: 'utf-8',
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('every scripts/ export a skill or agent imports exists', () => {
  const sites = callSites();
  assert.ok(sites.length >= 10, `expected the known call sites, found ${sites.length}`);
  assert.deepEqual(unresolved(sites), []);
});
