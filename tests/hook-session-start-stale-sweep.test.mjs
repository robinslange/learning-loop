// Tests for the stale-artifact sweeps that run on SessionStart.
//
// cache-cleanup.mjs covers two leftovers in the current plugin-data:
//   1. bin/ll-search.*-bak — orphaned backups from the old delta-patch updater.
//   2. convergence/*.json older than CONVERGENCE_TTL_MS — regenerable telemetry.
//
// vault-snapshot.mjs runs the TTL sweep: retrieval/session-dedupe + markers/
// (7d), edges.db.<pid>.tmp orphans (1h), tmp per-session/legacy markers (7d,
// never the live learning-loop-session-id fallback), plus retrieval log AND
// logs/log-YYYY-MM.jsonl month-pruning (drop months older than the
// RETRIEVAL_LOG_KEEP_MONTHS cutoff, by age rather than per-prefix count) and
// librarian queue.jsonl.bak.* reaping (7d TTL).
//
// Fixtures use matching installed/running versions so the binary-update block
// early-returns and never spawns a downloader — isolating the sweep behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  utimesSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { run as runCacheCleanup } from '../plugin/hooks/session-start/cache-cleanup.mjs';
import { run } from '../plugin/hooks/session-start/vault-snapshot.mjs';
import { HookConfig } from '../plugin/scripts/lib/hook-config.mjs';
import { monthStr } from '../plugin/scripts/lib/retrieval.mjs';
import { retentionCutoffMonth } from '../plugin/hooks/session-start/vault-snapshot.mjs';
import { runHook } from './helpers/hook-runner.mjs';

const HOOK = fileURLToPath(new URL('../plugin/hooks/session-start.js', import.meta.url));
const VAULT = fileURLToPath(new URL('./fixtures/vault-small', import.meta.url));

function makeFixture({ version = '1.25.1' } = {}) {
  const sb = mkdtempSync(join(tmpdir(), 'll-sweep-'));
  const pluginDir = join(sb, 'plugin', version);
  const pluginData = join(sb, 'plugin-data');
  const binDir = join(pluginData, 'bin');
  const convergenceDir = join(pluginData, 'convergence');
  mkdirSync(join(pluginDir, 'scripts'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(convergenceDir, { recursive: true });

  // Matching .version so the binary-update block early-returns (no spawn).
  writeFileSync(join(binDir, '.version'), 'v' + version + '\n');

  return {
    sandbox: sb,
    binDir,
    convergenceDir,
    ctx: { pluginDir, pluginVersion: version, pluginData },
    cleanup: () => rmSync(sb, { recursive: true, force: true }),
  };
}

async function withSandbox(fx, fn) {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fx.ctx.pluginData;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    fx.cleanup();
  }
}

function ageFile(path, ms) {
  const t = (Date.now() - ms) / 1000;
  utimesSync(path, t, t);
}

// Mirrors scripts/lib/retrieval.mjs monthStr(), offset by `back` whole
// months, so fixtures always bracket the *real* current month instead of
// hardcoding calendar dates that would go stale.
function monthOffset(back) {
  const d = new Date();
  d.setDate(1); // avoid month-length rollover (e.g. day 31 minus a month)
  d.setMonth(d.getMonth() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

test('sweep: removes orphaned ll-search.*-bak binaries', async () => {
  const fx = makeFixture();
  const baks = ['ll-search.preDelta-bak', 'll-search.preDelta2-bak', 'll-search.preDelta3-bak'].map(
    (n) => join(fx.binDir, n),
  );
  for (const p of baks) writeFileSync(p, 'stale-binary-bytes');

  await withSandbox(fx, async () => {
    await runCacheCleanup(fx.ctx);
    for (const p of baks) {
      assert.equal(existsSync(p), false, `should delete ${p}`);
    }
  });
});

test('sweep: preserves the live ll-search binary and .version', async () => {
  const fx = makeFixture();
  const live = join(fx.binDir, 'll-search');
  writeFileSync(live, 'live-binary');
  writeFileSync(join(fx.binDir, 'll-search.preDelta-bak'), 'stale');

  await withSandbox(fx, async () => {
    await runCacheCleanup(fx.ctx);
    assert.equal(existsSync(live), true, 'live ll-search must survive');
    assert.equal(existsSync(join(fx.binDir, '.version')), true, '.version must survive');
    assert.equal(
      existsSync(join(fx.binDir, 'll-search.preDelta-bak')),
      false,
      'stale backup must be gone',
    );
  });
});

test('sweep: deletes convergence files older than the TTL, keeps fresh ones', async () => {
  const fx = makeFixture();
  const stale = join(fx.convergenceDir, 'discovery-old.json');
  const fresh = join(fx.convergenceDir, 'discovery-recent.json');
  writeFileSync(stale, '{}');
  writeFileSync(fresh, '{}');
  ageFile(stale, HookConfig.CONVERGENCE_TTL_MS + 60_000); // just past TTL
  ageFile(fresh, HookConfig.CONVERGENCE_TTL_MS - 60_000); // just within TTL

  await withSandbox(fx, async () => {
    await runCacheCleanup(fx.ctx);
    assert.equal(existsSync(stale), false, 'stale convergence file must be deleted');
    assert.equal(existsSync(fresh), true, 'fresh convergence file must survive');
  });
});

test(
  'TTL sweep reaps markers/, tmp legacies, and edges tmp orphans — never the session-id file',
  { timeout: 12000 },
  () => {
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    const isolatedTmp = mkdtempSync(join(realpathSync(tmpdir()), 'll-sweep-tmp-'));
    // Separate dir for the session-id rewrite: the hook rewrites
    // learning-loop-session-id (refreshing its mtime) BEFORE the sweep, so the
    // seeded 8-day-old copy in isolatedTmp only stays old — and the never-sweep
    // assertion only stays load-bearing — if the rewrite lands elsewhere.
    const sessionTmp = mkdtempSync(join(realpathSync(tmpdir()), 'll-sweep-sid-'));

    const oldTmpFiles = [
      'claude-session-label-oldsid.txt',
      'learning-loop-last-dream',
      'learning-loop-memory-snapshot-oldsid',
    ];

    const r = runHook(HOOK, {
      env: { VAULT_PATH: VAULT, TMPDIR: isolatedTmp, LL_SESSION_TMP_DIR: sessionTmp },
      stdin: '',
      seed: (pluginDataDir) => {
        writeFileSync(
          join(pluginDataDir, 'update-check.json'),
          JSON.stringify({
            checked: Math.floor(Date.now() / 1000) - 5,
            update_available: false,
            installed: '1.17.3',
            latest: '1.17.3',
          }),
        );
        const markers = join(pluginDataDir, 'markers');
        mkdirSync(markers, { recursive: true });
        writeFileSync(join(markers, 'memory-snapshot-stale'), '[]');
        utimesSync(join(markers, 'memory-snapshot-stale'), eightDaysAgo, eightDaysAgo);
        writeFileSync(join(markers, 'memory-snapshot-fresh'), '[]');
        writeFileSync(join(pluginDataDir, 'edges.db.12345.tmp'), 'x');
        utimesSync(join(pluginDataDir, 'edges.db.12345.tmp'), twoHoursAgo, twoHoursAgo);
        for (const n of oldTmpFiles) {
          writeFileSync(join(isolatedTmp, n), 'x');
          utimesSync(join(isolatedTmp, n), eightDaysAgo, eightDaysAgo);
        }
        writeFileSync(join(isolatedTmp, 'learning-loop-session-id'), 'keep-me');
        utimesSync(join(isolatedTmp, 'learning-loop-session-id'), eightDaysAgo, eightDaysAgo);
      },
    });
    try {
      assert.equal(r.exitCode, 0, r.stderr);
      assert.ok(
        !existsSync(join(r.pluginDataDir, 'markers', 'memory-snapshot-stale')),
        'stale marker swept',
      );
      assert.ok(
        existsSync(join(r.pluginDataDir, 'markers', 'memory-snapshot-fresh')),
        'fresh marker kept',
      );
      assert.ok(!existsSync(join(r.pluginDataDir, 'edges.db.12345.tmp')), 'edges tmp orphan swept');
      assert.deepEqual(
        readdirSync(isolatedTmp).sort(),
        ['learning-loop-session-id'],
        'all three legacies swept; the 8-day-old session-id file must NEVER be swept',
      );
      assert.equal(
        readFileSync(join(isolatedTmp, 'learning-loop-session-id'), 'utf8'),
        'keep-me',
        'seeded session-id survives untouched (the rewrite lands in sessionTmp)',
      );
    } finally {
      r.cleanup();
      rmSync(isolatedTmp, { recursive: true, force: true });
      rmSync(sessionTmp, { recursive: true, force: true });
    }
  },
);

test('TTL sweep is gated to once per 24h — a stale marker survives a same-day second run', async () => {
  const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
  const fx = makeFixture();
  const markers = join(fx.ctx.pluginData, 'markers');
  mkdirSync(markers, { recursive: true });

  // A common ctx for both runs; tmp points at an isolated dir so the legacy
  // tmp sweep has somewhere harmless to scan.
  const isolatedTmp = mkdtempSync(join(realpathSync(tmpdir()), 'll-sweep-gate-tmp-'));
  const baseCtx = {
    ...fx.ctx,
    tmp: isolatedTmp,
    projectDir: null,
    memoryDir: join(fx.sandbox, 'memdir'),
    payload: { session_id: 'gate-test-sid' },
  };

  await withSandbox(fx, async () => {
    // First run: no last-sweep marker → sweeps and stamps the marker.
    const stale1 = join(markers, 'memory-snapshot-stale-1');
    writeFileSync(stale1, '[]');
    utimesSync(stale1, eightDaysAgo, eightDaysAgo);
    await run({ ...baseCtx });
    assert.equal(existsSync(stale1), false, 'first run sweeps the stale marker');
    assert.ok(existsSync(join(markers, 'last-sweep')), 'first run stamps the last-sweep marker');

    // Second run, same day: gate sees the fresh marker → must NOT sweep.
    const stale2 = join(markers, 'memory-snapshot-stale-2');
    writeFileSync(stale2, '[]');
    utimesSync(stale2, eightDaysAgo, eightDaysAgo);
    await run({ ...baseCtx });
    assert.ok(existsSync(stale2), 'second same-day run is gated — the stale marker survives');
  });
  rmSync(isolatedTmp, { recursive: true, force: true });
});

test('sweep: no-ops cleanly when bin/ and convergence/ are absent', async () => {
  const fx = makeFixture();
  rmSync(fx.binDir, { recursive: true, force: true });
  rmSync(fx.convergenceDir, { recursive: true, force: true });

  await withSandbox(fx, async () => {
    await assert.doesNotReject(runCacheCleanup(fx.ctx));
  });
});

test('sweep: retrieval logs older than the RETRIEVAL_LOG_KEEP_MONTHS cutoff are pruned, current month untouched', async () => {
  const fx = makeFixture();
  const retrievalDir = join(fx.ctx.pluginData, 'retrieval');
  mkdirSync(retrievalDir, { recursive: true });

  // 7 months back (oldest) through the current month, for four prefixes —
  // mirrors the brief's shadow-injection-2026-01..-07 fixture but generated
  // relative to the real current month so the test never goes stale.
  const months = Array.from({ length: 7 }, (_, i) => monthOffset(6 - i)); // oldest..newest
  const prefixes = ['shadow-injection', 'queries', 'access', 'cache-health'];
  for (const prefix of prefixes) {
    for (const month of months) {
      writeFileSync(join(retrievalDir, `${prefix}-${month}.jsonl`), '{}\n');
    }
  }
  // provenance/ must never be touched by this sweep.
  const provenanceDir = join(fx.ctx.pluginData, 'provenance');
  mkdirSync(provenanceDir, { recursive: true });
  writeFileSync(join(provenanceDir, `history-${months[0]}.jsonl`), '{}\n');

  const isolatedTmp = mkdtempSync(join(realpathSync(tmpdir()), 'll-sweep-retention-tmp-'));
  const baseCtx = {
    ...fx.ctx,
    tmp: isolatedTmp,
    projectDir: null,
    memoryDir: join(fx.sandbox, 'memdir'),
    payload: { session_id: 'retention-test-sid' },
  };

  await withSandbox(fx, async () => {
    await run({ ...baseCtx });

    const currentMonth = months[months.length - 1];
    // The cutoff is absolute and shared by every prefix, not a per-prefix
    // count. These fixtures have contiguous months so both rules agree here;
    // the dead-prefix test below is the one that separates them.
    const cutoff = retentionCutoffMonth(HookConfig.RETRIEVAL_LOG_KEEP_MONTHS);
    const keep = new Set(months.filter((m) => m >= cutoff));
    for (const prefix of prefixes) {
      for (const month of months) {
        const p = join(retrievalDir, `${prefix}-${month}.jsonl`);
        if (keep.has(month)) {
          assert.ok(existsSync(p), `${prefix}-${month}.jsonl (at or after ${cutoff}) must survive`);
        } else {
          assert.equal(
            existsSync(p),
            false,
            `${prefix}-${month}.jsonl (beyond the window) must be pruned`,
          );
        }
      }
    }
    assert.ok(
      existsSync(join(retrievalDir, `shadow-injection-${currentMonth}.jsonl`)),
      'the current month is never below the cutoff',
    );
    assert.ok(
      existsSync(join(provenanceDir, `history-${months[0]}.jsonl`)),
      'provenance/ is never touched by the retrieval-log retention sweep',
    );
  });

  rmSync(isolatedTmp, { recursive: true, force: true });
});

test('sweep: logs/log-YYYY-MM.jsonl is pruned with the same RETRIEVAL_LOG_KEEP_MONTHS policy as retrieval logs', async () => {
  const fx = makeFixture();
  const logsDir = join(fx.ctx.pluginData, 'logs');
  mkdirSync(logsDir, { recursive: true });

  const currentMonth = monthOffset(0);
  const oldMonth = monthOffset(2 * HookConfig.RETRIEVAL_LOG_KEEP_MONTHS + 2);
  writeFileSync(join(logsDir, `log-${oldMonth}.jsonl`), '{}\n');
  writeFileSync(join(logsDir, `log-${currentMonth}.jsonl`), '{}\n');

  const isolatedTmp = mkdtempSync(join(realpathSync(tmpdir()), 'll-sweep-logs-retention-tmp-'));
  const baseCtx = {
    ...fx.ctx,
    tmp: isolatedTmp,
    projectDir: null,
    memoryDir: join(fx.sandbox, 'memdir'),
    payload: { session_id: 'logs-retention-test-sid' },
  };

  await withSandbox(fx, async () => {
    await run({ ...baseCtx });

    assert.equal(
      existsSync(join(logsDir, `log-${oldMonth}.jsonl`)),
      false,
      'a log month beyond the retention window must be pruned',
    );
    assert.ok(
      existsSync(join(logsDir, `log-${currentMonth}.jsonl`)),
      'the current month is never below the cutoff',
    );
  });

  rmSync(isolatedTmp, { recursive: true, force: true });
});

test('sweep: librarian queue.jsonl.bak.* older than 7 days removed, fresh backups and the live queue survive', async () => {
  const fx = makeFixture();
  const librarianDir = join(fx.ctx.pluginData, 'librarian');
  mkdirSync(librarianDir, { recursive: true });

  const eightDaysAgo = 8 * 24 * 60 * 60 * 1000;
  const oneDayAgo = 24 * 60 * 60 * 1000;

  const staleBak = join(librarianDir, 'queue.jsonl.bak.20260101T000000Z');
  const freshBak = join(librarianDir, 'queue.jsonl.bak.20260713T000000Z');
  const liveQueue = join(librarianDir, 'queue.jsonl');
  writeFileSync(staleBak, '{"stale":true}\n');
  writeFileSync(freshBak, '{"fresh":true}\n');
  writeFileSync(liveQueue, '{"live":true}\n');
  ageFile(staleBak, eightDaysAgo);
  ageFile(freshBak, oneDayAgo);
  ageFile(liveQueue, eightDaysAgo); // old mtime, but must never be swept — not a .bak. file

  const isolatedTmp = mkdtempSync(join(realpathSync(tmpdir()), 'll-sweep-librarian-tmp-'));
  const baseCtx = {
    ...fx.ctx,
    tmp: isolatedTmp,
    projectDir: null,
    memoryDir: join(fx.sandbox, 'memdir'),
    payload: { session_id: 'librarian-bak-test-sid' },
  };

  await withSandbox(fx, async () => {
    await run({ ...baseCtx });

    assert.equal(
      existsSync(staleBak),
      false,
      'queue.jsonl.bak.* older than 7 days must be removed',
    );
    assert.ok(existsSync(freshBak), 'queue.jsonl.bak.* within 7 days must survive');
    assert.ok(existsSync(liveQueue), 'the live queue.jsonl must never be swept');
  });

  rmSync(isolatedTmp, { recursive: true, force: true });
});

test('cache-cleanup leaves superseded sibling versions on disk', async () => {
  const fx = makeFixture({ version: '2.0.7' });
  const older = join(fx.sandbox, 'plugin', '2.0.6');
  mkdirSync(join(older, 'hooks'), { recursive: true });
  writeFileSync(join(older, 'hooks', 'session-start.js'), '// an open session still runs this\n');

  await withSandbox(fx, async () => {
    await runCacheCleanup(fx.ctx);
    assert.ok(
      existsSync(join(older, 'hooks', 'session-start.js')),
      'open sessions execute from 2.0.6 until they reload; Claude Code reaps it via .orphaned_at',
    );
  });
});

test('sweep: a prefix that stopped being written drains instead of keeping its last N forever', async () => {
  const fx = makeFixture();
  const retrievalDir = join(fx.ctx.pluginData, 'retrieval');
  mkdirSync(retrievalDir, { recursive: true });

  // `access` stopped being written months ago and has fewer files than the
  // keep-window. Retention keyed on months.slice(-keepMonths) keeps every one
  // of them forever, because a dead prefix never grows past the window that
  // would evict anything. Live effect: 17.7MB of access-* and 28MB of
  // cache-health-* pinned in plugin-data with no writer and no reader.
  const deadMonths = [monthOffset(5), monthOffset(4), monthOffset(3)];
  for (const month of deadMonths) {
    writeFileSync(join(retrievalDir, `access-${month}.jsonl`), '{}\n');
  }
  // an active prefix in the same directory must keep its window
  const liveMonth = monthOffset(0);
  writeFileSync(join(retrievalDir, `queries-${liveMonth}.jsonl`), '{}\n');

  const isolatedTmp = mkdtempSync(join(realpathSync(tmpdir()), 'll-sweep-dead-prefix-'));
  await withSandbox(fx, async () => {
    await run({
      ...fx.ctx,
      tmp: isolatedTmp,
      projectDir: null,
      memoryDir: join(fx.sandbox, 'memdir'),
      payload: { session_id: 'dead-prefix-sid' },
    });
    for (const month of deadMonths) {
      assert.equal(
        existsSync(join(retrievalDir, `access-${month}.jsonl`)),
        false,
        `access-${month}.jsonl is outside the retention window and must be pruned`,
      );
    }
    assert.ok(
      existsSync(join(retrievalDir, `queries-${liveMonth}.jsonl`)),
      'the current month of a live prefix survives',
    );
  });
  rmSync(isolatedTmp, { recursive: true, force: true });
});

// I1: the cutoff must be computed on the SAME local basis monthStr() uses for
// the filenames. retrieval.mjs states this twice ("Local time on purpose",
// "Readers must not compute these in UTC"). A UTC cutoff against local-named
// files disagrees for the first hours of every month: east of UTC it spares a
// file the rule says to prune, and west of UTC it deletes one up to half a day
// early. This is a delete path, so the western direction is the dangerous one.
test('retentionCutoffMonth is computed on monthStr local basis', () => {
  // local noon, mid-month: no UTC/local ambiguity, pins the plain arithmetic
  assert.equal(retentionCutoffMonth(3, new Date(2026, 8, 15, 12, 0)), '2026-07');
  assert.equal(retentionCutoffMonth(1, new Date(2026, 8, 15, 12, 0)), '2026-09');
});

test('retentionCutoffMonth crosses the year boundary', () => {
  assert.equal(retentionCutoffMonth(3, new Date(2026, 0, 15, 12, 0)), '2025-11');
  assert.equal(retentionCutoffMonth(6, new Date(2026, 1, 15, 12, 0)), '2025-09');
});

test('retentionCutoffMonth agrees with monthStr at a local month boundary', () => {
  // 1st of the month, 00:30 local. East of UTC this instant is still the
  // PREVIOUS month in UTC, which is where a UTC cutoff goes wrong.
  const boundary = new Date(2026, 9, 1, 0, 30);
  assert.equal(monthStr(boundary), '2026-10');
  assert.equal(
    retentionCutoffMonth(1, boundary),
    '2026-10',
    'keepMonths=1 keeps only the current local month',
  );
  assert.equal(retentionCutoffMonth(3, boundary), '2026-08');
});

// The bug this guards is a timezone bug, so it cannot be caught from a single
// zone: on a UTC runner (which CI is) a UTC implementation and a local one
// agree everywhere, and the test would pass against the defect. Each zone runs
// in its own process because TZ is read once, at first Date use.
test('retentionCutoffMonth follows the writer in both hemispheres', () => {
  // pathToFileURL, not a bare path: on Windows `process.cwd()` is `D:\\a\\...`,
  // and a dynamic import of that throws ERR_UNSUPPORTED_ESM_URL_SCHEME because
  // `d:` reads as the URL scheme. The .href is forward-slashed, so it also
  // survives being interpolated into this template.
  const retrievalUrl = pathToFileURL(join(process.cwd(), 'plugin/scripts/lib/retrieval.mjs')).href;
  const snapshotUrl = pathToFileURL(
    join(process.cwd(), 'plugin/hooks/session-start/vault-snapshot.mjs'),
  ).href;
  // Two instants, because they are not the same test. The eastward one is an
  // instant already past month end in UTC but not yet locally, where a UTC
  // cutoff spares a file the rule says to prune. The westward one is an instant
  // already in the new month in UTC but still in the old one locally, where a
  // UTC cutoff deletes a file up to half a day EARLY. vault-snapshot.mjs:22-24
  // names the westward direction as the one that loses data, and only the
  // eastward case was covered.
  const probe = (isoInstant) => `
    process.env.TZ;
    const { monthStr } = await import('${retrievalUrl}');
    const { retentionCutoffMonth } = await import('${snapshotUrl}');
    const boundary = new Date('${isoInstant}');
    console.log(JSON.stringify({
      writer: monthStr(boundary),
      cutoff1: retentionCutoffMonth(1, boundary),
    }));
  `;
  const instants = [
    // Sep 30 12:00Z: Oct 1 in Auckland, still Sep 30 in Los Angeles.
    ['eastward', new Date(Date.UTC(2026, 8, 30, 12, 0)).toISOString()],
    // Oct 1 03:00Z: Sep 30 20:00 in Los Angeles, already Oct in UTC.
    ['westward', new Date(Date.UTC(2026, 9, 1, 3, 0)).toISOString()],
  ];
  for (const [direction, instant] of instants) {
    for (const tz of ['Pacific/Auckland', 'America/Los_Angeles', 'UTC']) {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe(instant)], {
        env: { ...process.env, TZ: tz },
        encoding: 'utf-8',
      });
      assert.equal(r.status, 0, `probe failed in ${tz} (${direction}): ${r.stderr}`);
      const { writer, cutoff1 } = JSON.parse(r.stdout.trim());
      assert.equal(
        cutoff1,
        writer,
        `in ${tz} (${direction}) the keepMonths=1 cutoff must equal the month the writer names`,
      );
    }
  }
});

test('retentionCutoffMonth clamps a keepMonths that would sweep everything', () => {
  // The floor stops keepMonths=0 putting the cutoff a month in the future. The
  // ceiling closes the same door from the other side, and it is the one a
  // reader walks into: Infinity is the intuitive way to write "keep forever",
  // and it was the fail-dangerous input. At or above 3,286,170 the month
  // arithmetic leaves range, monthStr returns 'NaN-NaN', and every comparison
  // against it is false -- so every log is swept, including the live bucket.
  const now = new Date(2026, 8, 18);
  const current = monthStr(now);
  for (const keepMonths of [Infinity, 3286170, 1e9, Number.MAX_SAFE_INTEGER]) {
    const cutoff = retentionCutoffMonth(keepMonths, now);
    assert.doesNotMatch(cutoff, /NaN/, `keepMonths=${keepMonths} produced ${cutoff}`);
    assert.ok(
      current >= cutoff,
      `keepMonths=${keepMonths} must keep the live bucket (${current} vs cutoff ${cutoff})`,
    );
  }
});

test('retentionCutoffMonth never sweeps past the current month', () => {
  // The old rule carried an unconditional `keep.add(currentMonth)` floor. The
  // cutoff rule dropped it, so keepMonths=0 put the cutoff one month in the
  // FUTURE and every file including the live bucket the writer is appending to
  // became eligible for deletion. One character in hook-config makes a delete
  // path delete everything, so the floor belongs in the function.
  const now = new Date(2026, 8, 18, 12, 0);
  assert.equal(retentionCutoffMonth(0, now), '2026-09', 'keep=0 must not reach into the future');
  assert.equal(
    retentionCutoffMonth(-5, now),
    '2026-09',
    'a negative window cannot widen the sweep',
  );
  assert.equal(retentionCutoffMonth(1, now), '2026-09');
  assert.equal(retentionCutoffMonth(3, now), '2026-07');
});
