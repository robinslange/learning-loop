import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHook } from './helpers/hook-runner.mjs';
import { initRepo } from './helpers/git-fixture.mjs';
import { encodeProjectDir } from '../plugin/scripts/lib/paths.mjs';
import { gitEnv } from '../plugin/scripts/lib/session-ledger.mjs';

// realpathSync: on macOS tmpdir() sits behind a symlink (/tmp -> /private/tmp,
// or a /var/folders/... alias), and `git rev-parse --show-toplevel` always
// resolves it. Building repo/vault paths under the unresolved tmpdir() makes
// collectFacts' relative() walk out of the worktree on every edit path.
const TMP = realpathSync(tmpdir());

const HOOK = fileURLToPath(new URL('../plugin/hooks/session-ledger.js', import.meta.url));
let r2ctx;

function makeRepo(root) {
  // realpath root: git rev-parse --show-toplevel resolves symlinks (macOS
  // tmpdir()), so building the repo path on the unresolved sandboxRoot makes
  // resolveProject's worktreeRoot diverge from this path by prefix.
  const repo = join(realpathSync(root), 'my-repo');
  mkdirSync(repo);
  return initRepo(repo);
}
function makeVault(root) {
  const vault = join(root, 'vault');
  mkdirSync(join(vault, '4-projects'), { recursive: true });
  return vault;
}
const rec = (o) => JSON.stringify(o);
function transcript(root, { prompts = 2, editPath = null } = {}) {
  const lines = [];
  const t0 = Date.parse('2020-01-01T00:00:00.000Z'); // long before any commit, so --since catches it
  for (let i = 0; i < prompts; i++) {
    lines.push(
      rec({
        type: 'user',
        timestamp: new Date(t0 + i * 60000).toISOString(),
        message: { role: 'user', content: `prompt ${i}: build the ledger` },
      }),
    );
  }
  if (editPath) {
    lines.push(
      rec({
        type: 'assistant',
        timestamp: new Date(t0 + 1000).toISOString(),
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Edit',
              input: { file_path: editPath },
              caller: { type: 'direct' },
            },
          ],
        },
      }),
    );
  }
  const p = join(root, 'transcript.jsonl');
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}
function seedConfig(pluginDataDir, vault, extra = {}) {
  writeFileSync(
    join(pluginDataDir, 'config.json'),
    JSON.stringify({ vault_path: vault, ...extra }),
  );
}
function provenance(pluginDataDir) {
  const dir = join(pluginDataDir, 'provenance');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    );
}
function ledgerFiles(vault) {
  const dir = join(vault, '4-projects', 'my-repo', 'ledger');
  return existsSync(dir) ? readdirSync(dir) : [];
}

function run({
  event = 'Stop',
  reason,
  extraConfig = {},
  prompts = 2,
  edit = true,
  label = 'Plugin Hooks',
  transcriptMissing = false,
}) {
  const sid = randomUUID();
  let vault, repo;
  const result = runHook(HOOK, {
    // Match TMPDIR to this process's resolved tmpdir so the hook's tmpdir()
    // finds the label file the seed callback writes.
    env: { TMPDIR: TMP },
    seed: (pluginDataDir, sandboxRoot) => {
      vault = makeVault(sandboxRoot);
      repo = makeRepo(sandboxRoot);
      seedConfig(pluginDataDir, vault, extraConfig);
      if (label) writeFileSync(join(TMP, `claude-session-label-${sid}.txt`), label);
    },
    stdin: (sandboxRoot) => ({
      session_id: sid,
      hook_event_name: event,
      cwd: repo,
      transcript_path: transcriptMissing
        ? join(sandboxRoot, 'nope.jsonl')
        : transcript(sandboxRoot, { prompts, editPath: edit ? join(repo, 'a.txt') : null }),
      ...(event === 'Stop'
        ? { last_assistant_message: 'Ledger written, tests green.', stop_hook_active: false }
        : { reason }),
    }),
  });
  return { ...result, vault, repo, sid };
}

test('Stop writes a ledger note and one session-summary event', () => {
  const r = run({});
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.stdout.trim(), '', 'the hook must not print');
  const files = ledgerFiles(r.vault);
  assert.equal(files.length, 1);
  assert.match(
    files[0],
    new RegExp(`^\\d{4}-\\d{2}-\\d{2}-plugin-hooks-${r.sid.slice(0, 8)}\\.md$`),
  );
  const md = readFileSync(join(r.vault, '4-projects', 'my-repo', 'ledger', files[0]), 'utf8');
  assert.match(md, /status: open/);
  assert.match(md, /## Where it stopped\nLedger written, tests green\./);
  assert.match(md, /## Commits this session\n- [0-9a-f]+ ledger commit/);
  assert.match(md, /## Files changed\n- a\.txt \(1 edit\)/);
  const events = provenance(r.pluginDataDir).filter((e) => e.action === 'session-summary');
  assert.equal(events.length, 1);
  assert.equal(events[0].final, false);
  assert.equal(events[0].end_reason, 'open');
  assert.equal(events[0].files_edited, 1);
  assert.equal(events[0].source, 'hook');
  // First flush of the session: no started_head yet, so the range can't be
  // used and this must not read as a fallback.
  assert.equal(events[0].commits_source, 'since');
  assert.doesNotMatch(md, /range unavailable/);
  for (const k of ['path', 'project', 'repo', 'branch', 'prompt'])
    assert.ok(!(k in events[0]), `${k} leaked`);
  const marker = JSON.parse(
    readFileSync(join(r.pluginDataDir, 'markers', `ledger-${r.sid}.json`), 'utf8'),
  );
  assert.match(marker.started_head, /^[0-9a-f]{40}$/);
  r.cleanup();
});

test('Stop reaps a stale .tmp in the ledger dir but leaves a fresh one', () => {
  const sid = randomUUID();
  let ctx;
  const r = runHook(HOOK, {
    env: { TMPDIR: TMP },
    seed: (pluginDataDir, sandboxRoot) => {
      const vault = makeVault(sandboxRoot);
      const repo = makeRepo(sandboxRoot);
      seedConfig(pluginDataDir, vault);
      writeFileSync(join(TMP, `claude-session-label-${sid}.txt`), 'Plugin Hooks');
      const ledgerDir = join(vault, '4-projects', 'my-repo', 'ledger');
      mkdirSync(ledgerDir, { recursive: true });
      const stale = join(ledgerDir, 'orphan.md.12345.tmp');
      const fresh = join(ledgerDir, 'orphan.md.67890.tmp');
      writeFileSync(stale, 'stale');
      writeFileSync(fresh, 'fresh');
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(stale, twoHoursAgo, twoHoursAgo);
      ctx = { vault, repo, stale, fresh };
    },
    stdin: (sandboxRoot) => ({
      session_id: sid,
      hook_event_name: 'Stop',
      cwd: ctx.repo,
      transcript_path: transcript(sandboxRoot, { prompts: 2, editPath: join(ctx.repo, 'a.txt') }),
      last_assistant_message: 'swept',
      stop_hook_active: false,
    }),
  });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.ok(!existsSync(ctx.stale), 'stale .tmp must be reaped');
  assert.ok(existsSync(ctx.fresh), 'fresh .tmp must survive the sweep');
  r.cleanup();
});

test('a later Stop credits only commits made since the recorded HEAD, not the whole --since window', () => {
  const sid = randomUUID();
  let ctx;
  const r1 = runHook(HOOK, {
    env: { TMPDIR: TMP },
    seed: (pluginDataDir, sandboxRoot) => {
      const vault = makeVault(sandboxRoot);
      const repo = makeRepo(sandboxRoot);
      seedConfig(pluginDataDir, vault);
      writeFileSync(join(TMP, `claude-session-label-${sid}.txt`), 'Range Session');
      ctx = { vault, repo };
    },
    stdin: (sandboxRoot) => ({
      session_id: sid,
      hook_event_name: 'Stop',
      cwd: ctx.repo,
      transcript_path: transcript(sandboxRoot, { prompts: 2, editPath: join(ctx.repo, 'a.txt') }),
      last_assistant_message: 'first flush',
      stop_hook_active: false,
    }),
  });
  assert.equal(r1.exitCode, 0, r1.stderr);
  const r1Marker = JSON.parse(
    readFileSync(join(r1.pluginDataDir, 'markers', `ledger-${sid}.json`), 'utf8'),
  );
  const { started_head: startedHead, path: ledgerRelPath } = r1Marker;

  // A commit made after the recorded HEAD, by this session. ctx.repo lives
  // in r1's sandbox, so r1 is cleaned up only after r2 (which reuses it via
  // ctx) has finished with it.
  execFileSync('git', ['-C', ctx.repo, 'commit', '--allow-empty', '-q', '-m', 'session commit'], {
    stdio: 'ignore',
    env: gitEnv(),
  });

  const r2 = runHook(HOOK, {
    env: { TMPDIR: TMP },
    seed: (pluginDataDir) => {
      seedConfig(pluginDataDir, ctx.vault);
      mkdirSync(join(pluginDataDir, 'markers'), { recursive: true });
      writeFileSync(
        join(pluginDataDir, 'markers', `ledger-${sid}.json`),
        JSON.stringify({
          path: ledgerRelPath,
          started_ts: '2020-01-01T00:00:00.000Z',
          started_head: startedHead,
          last_summary_ts: '2020-01-01T00:00:00.000Z',
        }),
      );
    },
    stdin: (sandboxRoot) => ({
      session_id: sid,
      hook_event_name: 'SessionEnd',
      cwd: ctx.repo,
      transcript_path: transcript(sandboxRoot, { prompts: 2 }),
      reason: 'other',
    }),
  });
  assert.equal(r2.exitCode, 0, r2.stderr);
  const events = provenance(r2.pluginDataDir).filter((e) => e.action === 'session-summary');
  assert.equal(events[0].commits_source, 'range');
  const files = ledgerFiles(ctx.vault);
  const md = readFileSync(join(ctx.vault, '4-projects', 'my-repo', 'ledger', files[0]), 'utf8');
  assert.match(md, /## Commits this session\n- [0-9a-f]+ session commit/);
  assert.doesNotMatch(
    md,
    /ledger commit/,
    'the setup commit predates the session and must not be listed',
  );
  r2.cleanup();
  r1.cleanup();
});

test('a marker with a started_head that is no longer an ancestor falls back to --since and the note says so', () => {
  const sid = randomUUID();
  let ctx;
  const r = runHook(HOOK, {
    env: { TMPDIR: TMP },
    seed: (pluginDataDir, sandboxRoot) => {
      const vault = makeVault(sandboxRoot);
      const repo = makeRepo(sandboxRoot);
      seedConfig(pluginDataDir, vault);
      mkdirSync(join(pluginDataDir, 'markers'), { recursive: true });
      writeFileSync(
        join(pluginDataDir, 'markers', `ledger-${sid}.json`),
        JSON.stringify({
          path: 'existing-note.md',
          started_ts: new Date(Date.now() - 3_600_000).toISOString(),
          // Not an ancestor of anything in this fresh repo.
          started_head: 'f'.repeat(40),
          last_summary_ts: new Date(Date.now() - 3_600_000).toISOString(),
        }),
      );
      ctx = { vault, repo };
    },
    stdin: (sandboxRoot) => ({
      session_id: sid,
      hook_event_name: 'Stop',
      cwd: ctx.repo,
      transcript_path: transcript(sandboxRoot, { prompts: 2, editPath: join(ctx.repo, 'a.txt') }),
      last_assistant_message: 'fell back',
      stop_hook_active: false,
    }),
  });
  assert.equal(r.exitCode, 0, r.stderr);
  const events = provenance(r.pluginDataDir).filter((e) => e.action === 'session-summary');
  assert.equal(events[0].commits_source, 'since');
  const md = readFileSync(join(ctx.vault, 'existing-note.md'), 'utf8');
  assert.match(md, /## Commits this session \(range unavailable, listed by time\)/);
  r.cleanup();
});

test('a second Stop overwrites the same note and does not re-emit inside the interval', () => {
  // Two runs share nothing (fresh sandbox each), so simulate the marker by
  // running twice against one sandbox via the seeded marker.
  let firstPath;
  const r1 = run({});
  const sid = r1.sid;
  const marker = JSON.parse(
    readFileSync(join(r1.pluginDataDir, 'markers', `ledger-${sid}.json`), 'utf8'),
  );
  firstPath = marker.path;
  assert.ok(firstPath.startsWith('4-projects/my-repo/ledger/'));
  assert.ok(marker.last_summary_ts);
  r1.cleanup();

  const r2 = runHook(HOOK, {
    env: { TMPDIR: TMP },
    seed: (pluginDataDir, sandboxRoot) => {
      const vault = makeVault(sandboxRoot);
      const repo = makeRepo(sandboxRoot);
      seedConfig(pluginDataDir, vault);
      mkdirSync(join(pluginDataDir, 'markers'), { recursive: true });
      writeFileSync(
        join(pluginDataDir, 'markers', `ledger-${sid}.json`),
        JSON.stringify({
          path: firstPath,
          started_ts: '2020-01-01T00:00:00.000Z',
          last_summary_ts: new Date().toISOString(),
        }),
      );
      writeFileSync(join(TMP, `claude-session-label-${sid}.txt`), 'Some Other Label');
      r2ctx = { vault, repo, sandboxRoot };
    },
    stdin: (sandboxRoot) => ({
      session_id: sid,
      hook_event_name: 'Stop',
      cwd: r2ctx.repo,
      transcript_path: transcript(sandboxRoot, { prompts: 2, editPath: join(r2ctx.repo, 'a.txt') }),
      last_assistant_message: 'again',
      stop_hook_active: false,
    }),
  });
  assert.equal(r2.exitCode, 0, r2.stderr);
  const files = ledgerFiles(r2ctx.vault);
  assert.deepEqual(
    files,
    [firstPath.split('/').pop()],
    'filename pinned by the marker, not the new label',
  );
  assert.equal(
    provenance(r2.pluginDataDir).filter((e) => e.action === 'session-summary').length,
    0,
  );
  r2.cleanup();
});

test('the marker seeded before Stop wins the pin: both path and started_head survive, the note lands at the seeded path', () => {
  const sid = randomUUID();
  let ctx;
  const seededPath = '4-projects/my-repo/ledger/2020-01-01-seeded-session-aaaaaaaa.md';
  const seededHead = 'a'.repeat(40);
  const r = runHook(HOOK, {
    env: { TMPDIR: TMP },
    seed: (pluginDataDir, sandboxRoot) => {
      const vault = makeVault(sandboxRoot);
      const repo = makeRepo(sandboxRoot);
      seedConfig(pluginDataDir, vault);
      mkdirSync(join(pluginDataDir, 'markers'), { recursive: true });
      // Seeded BEFORE this Stop runs, standing in for a first flush that
      // already won the pin with a different path and started_head than
      // this flush would independently compute (a different label, a
      // different HEAD at process start).
      writeFileSync(
        join(pluginDataDir, 'markers', `ledger-${sid}.json`),
        JSON.stringify({
          path: seededPath,
          started_ts: '2020-01-01T00:00:00.000Z',
          started_head: seededHead,
        }),
      );
      writeFileSync(join(TMP, `claude-session-label-${sid}.txt`), 'This Flush Own Label');
      ctx = { vault, repo };
    },
    stdin: (sandboxRoot) => ({
      session_id: sid,
      hook_event_name: 'Stop',
      cwd: ctx.repo,
      transcript_path: transcript(sandboxRoot, { prompts: 2, editPath: join(ctx.repo, 'a.txt') }),
      last_assistant_message: 'second writer, must not clobber the pin',
      stop_hook_active: false,
    }),
  });
  assert.equal(r.exitCode, 0, r.stderr);
  const marker = JSON.parse(
    readFileSync(join(r.pluginDataDir, 'markers', `ledger-${sid}.json`), 'utf8'),
  );
  assert.equal(marker.path, seededPath, 'first writer path must survive under the lock');
  assert.equal(marker.started_head, seededHead, 'first writer started_head must survive too');
  assert.ok(
    existsSync(join(ctx.vault, seededPath)),
    "the note must be written at the pinned path, not this flush's own computed path",
  );
  const files = ledgerFiles(ctx.vault);
  assert.deepEqual(files, [seededPath.split('/').pop()]);
  r.cleanup();
});

test('a fresh sandbox with no markers/ dir yet does not log a session-ledger.lock error', () => {
  const r = run({});
  assert.equal(r.exitCode, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /session-ledger\.lock/);
  r.cleanup();
});

test('SessionEnd stamps status ended, the reason, and emits final:true', () => {
  const r = run({ event: 'SessionEnd', reason: 'clear' });
  assert.equal(r.exitCode, 0, r.stderr);
  const files = ledgerFiles(r.vault);
  const md = readFileSync(join(r.vault, '4-projects', 'my-repo', 'ledger', files[0]), 'utf8');
  assert.match(md, /status: ended\nended_reason: clear\n---/);
  assert.doesNotMatch(md, /## Where it stopped/);
  const events = provenance(r.pluginDataDir).filter((e) => e.action === 'session-summary');
  assert.equal(events.length, 1);
  assert.equal(events[0].final, true);
  assert.equal(events[0].end_reason, 'clear');
  r.cleanup();
});

test('a trivial session (no edits, no commits since start, few prompts) writes nothing', () => {
  const sid = randomUUID();
  let ctx;
  const r = runHook(HOOK, {
    seed: (pluginDataDir, sandboxRoot) => {
      const vault = makeVault(sandboxRoot);
      const repo = makeRepo(sandboxRoot);
      seedConfig(pluginDataDir, vault);
      ctx = { vault, repo };
    },
    stdin: (sandboxRoot) => {
      const now = Date.now() + 60_000; // transcript starts after the setup commit
      const lines = [0, 1].map((i) =>
        rec({
          type: 'user',
          timestamp: new Date(now + i * 1000).toISOString(),
          message: { role: 'user', content: `hi ${i}` },
        }),
      );
      const p = join(sandboxRoot, 't.jsonl');
      writeFileSync(p, lines.join('\n'));
      return {
        session_id: sid,
        hook_event_name: 'Stop',
        cwd: ctx.repo,
        transcript_path: p,
        last_assistant_message: 'hello',
        stop_hook_active: false,
      };
    },
  });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(ledgerFiles(ctx.vault), []);
  assert.equal(provenance(r.pluginDataDir).length, 0);
  assert.ok(!existsSync(join(r.pluginDataDir, 'markers', `ledger-${sid}.json`)));
  r.cleanup();
});

test('hooks.disabled silences the hook entirely', () => {
  const r = run({ extraConfig: { hooks: { disabled: ['session-ledger'] } } });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(ledgerFiles(r.vault), []);
  assert.equal(provenance(r.pluginDataDir).length, 0);
  r.cleanup();
});

test('stop_hook_active exits without writing', () => {
  const sid = randomUUID();
  let ctx;
  const r = runHook(HOOK, {
    seed: (pluginDataDir, sandboxRoot) => {
      ctx = { vault: makeVault(sandboxRoot), repo: makeRepo(sandboxRoot) };
      seedConfig(pluginDataDir, ctx.vault);
    },
    stdin: (sandboxRoot) => ({
      session_id: sid,
      hook_event_name: 'Stop',
      cwd: ctx.repo,
      transcript_path: transcript(sandboxRoot, { prompts: 6 }),
      stop_hook_active: true,
    }),
  });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(ledgerFiles(ctx.vault), []);
  r.cleanup();
});

test('an unreadable transcript still yields a ledger from git facts and logs the error', () => {
  const r = run({ transcriptMissing: true });
  assert.equal(r.exitCode, 0, r.stderr);
  const files = ledgerFiles(r.vault);
  assert.equal(files.length, 1, 'the setup commit alone makes the session non-trivial');
  const md = readFileSync(join(r.vault, '4-projects', 'my-repo', 'ledger', files[0]), 'utf8');
  assert.match(md, /## Commits this session/);
  assert.doesNotMatch(md, /## Goal/);
  const logs = join(r.pluginDataDir, 'logs');
  const logged =
    existsSync(logs) &&
    readdirSync(logs).some((f) =>
      readFileSync(join(logs, f), 'utf8').includes('session-ledger.transcript'),
    );
  assert.ok(logged, 'transcript read failure must be logged, not swallowed');
  r.cleanup();
});

test('the projects map renames the folder', () => {
  const r = run({ extraConfig: { projects: { 'my-repo': 'curated-name' } } });
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(ledgerFiles(r.vault), []);
  assert.equal(readdirSync(join(r.vault, '4-projects', 'curated-name', 'ledger')).length, 1);
  const ev = provenance(r.pluginDataDir).find((e) => e.action === 'session-summary');
  assert.equal(ev.project_source, 'mapped');
  const marker = JSON.parse(
    readFileSync(
      join(r.pluginDataDir, 'markers', `ledger-project-${encodeProjectDir(r.repo)}.json`),
      'utf8',
    ),
  );
  assert.deepEqual(marker, { project: 'curated-name' });
  r.cleanup();
});
