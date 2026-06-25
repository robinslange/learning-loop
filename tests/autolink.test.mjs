// tests/autolink.test.mjs
// Characterisation tests for hooks/modules/autolink.mjs — the only post-tool
// module that mutates OTHER vault notes. Exercised at the boundary through
// the coalesced post-tool.js dispatcher (same pattern as hook-post-tool.test.mjs),
// with the ll-search binary stubbed so the similarity path is deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHook } from './helpers/hook-runner.mjs';
import { skipOnWindows } from './helpers/platform.mjs';

const SKIP = skipOnWindows('shebang stub + chmod semantics: not supported on win32');

const HOOK = fileURLToPath(new URL('../plugin/hooks/post-tool.js', import.meta.url));

const SLEEP_NOTE = '---\ntags: [sleep]\n---\n\nPermanent note on sleep science.\n';
const CIRCADIAN_NOTE = '---\ntags: [circadian]\n---\n\nPermanent note on circadian rhythm.\n';

// Fresh throwaway vault per test: autolink appends backlinks to target notes,
// so tests must never share the checked-in fixture vault.
function makeVault() {
  const root = mkdtempSync(join(tmpdir(), 'll-autolink-vault-'));
  mkdirSync(join(root, '0-inbox'), { recursive: true });
  mkdirSync(join(root, '3-permanent'), { recursive: true });
  mkdirSync(join(root, '_system'), { recursive: true });
  writeFileSync(join(root, '3-permanent', 'sleep.md'), SLEEP_NOTE);
  writeFileSync(join(root, '3-permanent', 'circadian.md'), CIRCADIAN_NOTE);
  return root;
}

// Stub ll-search into the sandbox's plugin-data bin (findBinary()'s first
// slot — beats any locally built native/target/release binary). Seeding a
// stub in EVERY test also keeps the sibling edge-infer module off the real
// model, so runs are fast and deterministic. The stub only answers the
// `similar` subcommand; everything else exits 0 with no output.
function stubBinary(pluginDataDir, { similarJson = '[]', sleepSecs = 0, markerPath = null } = {}) {
  const binDir = join(pluginDataDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const lines = ['#!/bin/sh', 'if [ "$1" = "similar" ]; then'];
  if (markerPath) lines.push(`  : > '${markerPath}'`);
  if (sleepSecs) lines.push(`  sleep ${sleepSecs}`);
  lines.push(`  cat <<'JSON'`, similarJson, 'JSON', 'fi', 'exit 0');
  writeFileSync(join(binDir, 'll-search'), lines.join('\n') + '\n', { mode: 0o755 });
}

function readAutolinkErrors(pluginDataDir) {
  const lines = [];
  if (!existsSync(pluginDataDir)) return lines;
  for (const f of ['hook-errors-' + new Date().toISOString().slice(0, 7) + '.jsonl']) {
    const p = join(pluginDataDir, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.trim())) {
      lines.push(JSON.parse(line));
    }
  }
  return lines.filter((e) => e.module === 'runAutolink');
}

function writeStdin(vault, relPath, content) {
  const filePath = join(vault, relPath);
  writeFileSync(filePath, content);
  return {
    tool_name: 'Write',
    tool_input: { file_path: filePath, content },
    tool_response: { success: true },
  };
}

// mlTimeoutMs overrides autolink's similarity-exec wall-clock timeout. Default
// is generous: the 1s production budget is the right fail-open value, but under
// a contended full-suite run the stubbed similarity exec can exceed it before
// returning, dropping the appended links and flaking the similarity test. The
// timeout-containment test passes the production 1000ms explicitly, since the
// short budget firing is exactly what it asserts. Production default unchanged.
function run(stdin, vault, seed, { mlTimeoutMs = 30000 } = {}) {
  return runHook(HOOK, {
    stdin,
    env: { VAULT_PATH: vault, LL_AUTOLINK_ML_TIMEOUT_MS: String(mlTimeoutMs) },
    seed,
  });
}

test(
  'autolink: Write with [[wikilink]] appends backlink to target exactly once, frontmatter intact',
  { skip: SKIP },
  () => {
    const vault = makeVault();
    const stdin = writeStdin(
      vault,
      '0-inbox/new-note.md',
      '---\ntags: [test]\n---\n\nLinks to [[sleep]].\n',
    );
    const r = run(stdin, vault, (pd) => stubBinary(pd));
    try {
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      const target = readFileSync(join(vault, '3-permanent', 'sleep.md'), 'utf8');
      // Exact-append contract: original content untouched (frontmatter and
      // body), backlink lands on its own trailing line.
      assert.equal(target, SLEEP_NOTE + '[[new-note]]\n');
      assert.ok(
        target.startsWith('---\ntags: [sleep]\n---\n'),
        'frontmatter must be preserved verbatim',
      );
      assert.deepEqual(readAutolinkErrors(r.pluginDataDir), []);
    } finally {
      r.cleanup();
      rmSync(vault, { recursive: true, force: true });
    }
  },
);

test(
  'autolink: re-running the hook does not duplicate the backlink (idempotent)',
  { skip: SKIP },
  () => {
    const vault = makeVault();
    const stdin = writeStdin(vault, '0-inbox/new-note.md', 'Links to [[sleep]].\n');
    const r1 = run(stdin, vault, (pd) => stubBinary(pd));
    r1.cleanup();
    const r2 = run(stdin, vault, (pd) => stubBinary(pd));
    try {
      assert.equal(r2.exitCode, 0);
      const target = readFileSync(join(vault, '3-permanent', 'sleep.md'), 'utf8');
      const occurrences = target.split('[[new-note]]').length - 1;
      assert.equal(occurrences, 1, `backlink duplicated:\n${target}`);
    } finally {
      r2.cleanup();
      rmSync(vault, { recursive: true, force: true });
    }
  },
);

test(
  'autolink: target without trailing newline gets backlink on a fresh line, not glued',
  { skip: SKIP },
  () => {
    const vault = makeVault();
    writeFileSync(
      join(vault, '3-permanent', 'sleep.md'),
      '---\ntags: [sleep]\n---\n\nNo trailing newline here.',
    );
    const stdin = writeStdin(vault, '0-inbox/new-note.md', 'See [[sleep]].\n');
    const r = run(stdin, vault, (pd) => stubBinary(pd));
    try {
      assert.equal(r.exitCode, 0);
      const target = readFileSync(join(vault, '3-permanent', 'sleep.md'), 'utf8');
      assert.equal(target, '---\ntags: [sleep]\n---\n\nNo trailing newline here.\n[[new-note]]\n');
    } finally {
      r.cleanup();
      rmSync(vault, { recursive: true, force: true });
    }
  },
);

test(
  'autolink: wikilink to a note that exists nowhere is a no-op, no errors',
  { skip: SKIP },
  () => {
    const vault = makeVault();
    const stdin = writeStdin(
      vault,
      '0-inbox/new-note.md',
      'See [[does-not-exist]] and [[sleep]].\n',
    );
    const r = run(stdin, vault, (pd) => stubBinary(pd));
    try {
      assert.equal(r.exitCode, 0);
      // Unknown target skipped, known target still processed.
      const target = readFileSync(join(vault, '3-permanent', 'sleep.md'), 'utf8');
      assert.equal(target, SLEEP_NOTE + '[[new-note]]\n');
      assert.deepEqual(readAutolinkErrors(r.pluginDataDir), []);
    } finally {
      r.cleanup();
      rmSync(vault, { recursive: true, force: true });
    }
  },
);

test(
  'autolink: snapshot entry whose file is gone (ENOENT) is pruned and the loop continues',
  { skip: SKIP },
  () => {
    const vault = makeVault();
    const stdin = writeStdin(vault, '0-inbox/new-note.md', 'See [[ghost]] then [[sleep]].\n');
    const r = run(stdin, vault, (pd) => {
      stubBinary(pd);
      // Seed a stale snapshot listing a note that no longer exists on disk.
      writeFileSync(
        join(pd, 'vault-snapshot.json'),
        JSON.stringify({
          version: 1,
          vault_root: vault,
          built_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          notes: [
            { folder: '3-permanent', basename: 'ghost', rel_path: '3-permanent/ghost.md' },
            { folder: '3-permanent', basename: 'sleep', rel_path: '3-permanent/sleep.md' },
            { folder: '3-permanent', basename: 'circadian', rel_path: '3-permanent/circadian.md' },
          ],
        }),
      );
    });
    try {
      assert.equal(r.exitCode, 0);
      // Ghost pruned from the persisted snapshot.
      const snap = JSON.parse(readFileSync(join(r.pluginDataDir, 'vault-snapshot.json'), 'utf8'));
      assert.ok(
        !snap.notes.some((n) => n.rel_path === '3-permanent/ghost.md'),
        `ghost entry should be pruned: ${JSON.stringify(snap.notes)}`,
      );
      // ENOENT on ghost did not abort the backlink loop: sleep still linked.
      const target = readFileSync(join(vault, '3-permanent', 'sleep.md'), 'utf8');
      assert.equal(target, SLEEP_NOTE + '[[new-note]]\n');
      assert.deepEqual(readAutolinkErrors(r.pluginDataDir), []);
    } finally {
      r.cleanup();
      rmSync(vault, { recursive: true, force: true });
    }
  },
);

test(
  'autolink: unwritable target — hook exits 0, error isolated to hook-errors log, target uncorrupted',
  { skip: SKIP },
  () => {
    const vault = makeVault();
    const targetPath = join(vault, '3-permanent', 'sleep.md');
    chmodSync(targetPath, 0o444);
    const stdin = writeStdin(vault, '0-inbox/new-note.md', 'See [[sleep]].\n');
    const r = run(stdin, vault, (pd) => stubBinary(pd));
    try {
      assert.equal(r.exitCode, 0, 'dispatcher must isolate the module failure');
      assert.equal(r.stdout.trim(), '');
      assert.equal(
        readFileSync(targetPath, 'utf8'),
        SLEEP_NOTE,
        'read-only target must be untouched',
      );
      const errors = readAutolinkErrors(r.pluginDataDir);
      assert.equal(
        errors.length,
        1,
        `expected one isolated runAutolink error: ${JSON.stringify(errors)}`,
      );
    } finally {
      chmodSync(targetPath, 0o644);
      r.cleanup();
      rmSync(vault, { recursive: true, force: true });
    }
  },
);

test('autolink: failed tool_response short-circuits — no vault mutation', { skip: SKIP }, () => {
  const vault = makeVault();
  const filePath = join(vault, '0-inbox', 'new-note.md');
  writeFileSync(filePath, 'See [[sleep]].\n');
  const r = run(
    {
      tool_name: 'Write',
      tool_input: { file_path: filePath, content: 'See [[sleep]].\n' },
      tool_response: { success: false },
    },
    vault,
    (pd) => stubBinary(pd),
  );
  try {
    assert.equal(r.exitCode, 0);
    assert.equal(readFileSync(join(vault, '3-permanent', 'sleep.md'), 'utf8'), SLEEP_NOTE);
  } finally {
    r.cleanup();
    rmSync(vault, { recursive: true, force: true });
  }
});

test('autolink: writes under _system/ are not vault notes — no backlinks', { skip: SKIP }, () => {
  const vault = makeVault();
  const stdin = writeStdin(vault, '_system/config.md', 'See [[sleep]].\n');
  const r = run(stdin, vault, (pd) => stubBinary(pd));
  try {
    assert.equal(r.exitCode, 0);
    assert.equal(readFileSync(join(vault, '3-permanent', 'sleep.md'), 'utf8'), SLEEP_NOTE);
  } finally {
    r.cleanup();
    rmSync(vault, { recursive: true, force: true });
  }
});

test(
  'autolink similarity: appends at most 3 above-threshold candidates, skips low scores and existing links, writes reciprocal backlinks',
  { skip: SKIP },
  () => {
    const vault = makeVault();
    for (const name of ['cand-a', 'cand-b', 'cand-c', 'cand-d', 'cand-low']) {
      writeFileSync(join(vault, '3-permanent', `${name}.md`), `Note ${name}.\n`);
    }
    mkdirSync(join(vault, '.vault-search'), { recursive: true });
    writeFileSync(join(vault, '.vault-search', 'vault-index.db'), '');
    const content = '---\ntags: [test]\n---\n\nAlready links [[circadian]].\n';
    const stdin = writeStdin(vault, '0-inbox/new-note.md', content);
    const similarJson = JSON.stringify([
      { path: '3-permanent/cand-a.md', score: 0.9 },
      { path: '3-permanent/cand-b.md', score: 0.85 },
      { path: '3-permanent/circadian.md', score: 0.8 }, // already linked on disk — filtered
      { path: '3-permanent/cand-c.md', score: 0.7 },
      { path: '3-permanent/cand-d.md', score: 0.66 }, // 4th valid candidate — beyond MAX_AUTO_LINKS
      { path: '3-permanent/cand-low.md', score: 0.5 }, // below 0.65 threshold
    ]);
    const r = run(stdin, vault, (pd) => stubBinary(pd, { similarJson }));
    try {
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      const source = readFileSync(join(vault, '0-inbox', 'new-note.md'), 'utf8');
      assert.equal(source, content + '[[cand-a]]\n[[cand-b]]\n[[cand-c]]\n');
      assert.equal(
        source.split('[[circadian]]').length - 1,
        1,
        'existing link must not be duplicated',
      );
      // Reciprocal backlinks on the linked candidates only.
      for (const linked of ['cand-a', 'cand-b', 'cand-c']) {
        const t = readFileSync(join(vault, '3-permanent', `${linked}.md`), 'utf8');
        assert.equal(t, `Note ${linked}.\n[[new-note]]\n`);
      }
      for (const untouched of ['cand-d', 'cand-low']) {
        const t = readFileSync(join(vault, '3-permanent', `${untouched}.md`), 'utf8');
        assert.equal(t, `Note ${untouched}.\n`, `${untouched} must not be linked`);
      }
      // [[circadian]] was in the body, so the wikilink backlink loop covers it.
      assert.equal(
        readFileSync(join(vault, '3-permanent', 'circadian.md'), 'utf8'),
        CIRCADIAN_NOTE + '[[new-note]]\n',
      );
      assert.deepEqual(readAutolinkErrors(r.pluginDataDir), []);
    } finally {
      r.cleanup();
      rmSync(vault, { recursive: true, force: true });
    }
  },
);

test(
  'autolink: Edit tool appends backlinks from disk content but never runs the similarity path',
  { skip: SKIP },
  () => {
    const vault = makeVault();
    mkdirSync(join(vault, '.vault-search'), { recursive: true });
    writeFileSync(join(vault, '.vault-search', 'vault-index.db'), '');
    const filePath = join(vault, '0-inbox', 'edited-note.md');
    writeFileSync(filePath, 'Now links [[sleep]].\n');
    const markerPath = join(vault, '.similar-was-called');
    const r = run(
      {
        tool_name: 'Edit',
        tool_input: { file_path: filePath, old_string: 'x', new_string: 'y' },
        tool_response: { success: true },
      },
      vault,
      (pd) =>
        stubBinary(pd, {
          similarJson: '[{"path":"3-permanent/circadian.md","score":0.9}]',
          markerPath,
        }),
    );
    try {
      assert.equal(r.exitCode, 0);
      assert.equal(
        readFileSync(join(vault, '3-permanent', 'sleep.md'), 'utf8'),
        SLEEP_NOTE + '[[edited-note]]\n',
      );
      assert.ok(!existsSync(markerPath), 'similarity subcommand must not run for Edit');
      assert.equal(
        readFileSync(filePath, 'utf8'),
        'Now links [[sleep]].\n',
        'no auto-links appended on Edit',
      );
    } finally {
      r.cleanup();
      rmSync(vault, { recursive: true, force: true });
    }
  },
);

test(
  'autolink: similarity binary hanging past its timeout is contained — backlinks still applied, no module failure',
  { skip: SKIP },
  () => {
    const vault = makeVault();
    mkdirSync(join(vault, '.vault-search'), { recursive: true });
    writeFileSync(join(vault, '.vault-search', 'vault-index.db'), '');
    const content = 'See [[sleep]].\n';
    const stdin = writeStdin(vault, '0-inbox/new-note.md', content);
    // Pin the production 1000ms ML timeout; a 3s stub must be killed by the
    // execFileSync timeout and swallowed inside the module.
    const r = run(
      stdin,
      vault,
      (pd) =>
        stubBinary(pd, {
          similarJson: '[{"path":"3-permanent/circadian.md","score":0.9}]',
          sleepSecs: 3,
        }),
      { mlTimeoutMs: 1000 },
    );
    try {
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      // Wikilink backlink phase ran before the similarity call.
      assert.equal(
        readFileSync(join(vault, '3-permanent', 'sleep.md'), 'utf8'),
        SLEEP_NOTE + '[[new-note]]\n',
      );
      // Timeout aborted the similarity phase: no auto-links, no reciprocal write.
      assert.equal(readFileSync(join(vault, '0-inbox', 'new-note.md'), 'utf8'), content);
      assert.equal(
        readFileSync(join(vault, '3-permanent', 'circadian.md'), 'utf8'),
        CIRCADIAN_NOTE,
      );
      // Handled inside the module (logError), not surfaced as a module crash.
      assert.deepEqual(readAutolinkErrors(r.pluginDataDir), []);
    } finally {
      r.cleanup();
      rmSync(vault, { recursive: true, force: true });
    }
  },
);
