#!/usr/bin/env node
// scripts/health-check.mjs — orchestrates the health-check library.
//
// Exports:
//   - runQuickChecks(ctx): no shell-outs, ~50ms
//   - runFullChecks(ctx):  quick + CLI invocations + I/O, ~500ms
//   - formatMissingDeps(result): markdown string for context-assembly
//
// CLI:
//   node scripts/health-check.mjs --full --json
//   node scripts/health-check.mjs --quick --text

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as quick from './lib/health-checks/quick.mjs';
import * as full from './lib/health-checks/full.mjs';
import { makeCheck, SEVERITIES } from './lib/health-checks/types.mjs';
import { abiDriftSummary } from './check-deps-impl.mjs';
import { resolvePluginData, getVaultPath, getConfig } from './lib/config.mjs';
import { pluginVersion } from './lib/plugin-meta.mjs';
import { isProcessAlive } from './lib/file-lock.mjs';
import { env, isOffline } from './lib/env.mjs';
import { DATA_FILES, binaryFileName } from './lib/paths.mjs';
import { listVaultNotes } from './lib/vault-walk.mjs';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/is-main.mjs';

// fileURLToPath, not .pathname: on Windows a file URL's pathname is
// `/D:/a/...`, which resolves against the drive root as `D:\D:\a\...`.
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url));

// The options every version probe runs under.
//
// Windows: execFileSync does not honor PATHEXT, so bare 'claude'/'node' miss
// their .cmd shims and read as "not found". Route through cmd.exe.
//
// Split out and exported because that decision is platform-dependent and was
// otherwise unreachable from a POSIX runner -- observing it in place would mean
// mocking execFileSync, which is the middle of what is under test rather than
// its boundary. `platform` is injected with a default, matching binaryFileName
// and checkShimsExist.
export function execOptions(platform = process.platform) {
  return {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3000,
    shell: platform === 'win32',
  };
}

function safeExec(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { ...execOptions(), ...opts }).trim();
  } catch {
    return null;
  }
}

function readJsonSafe(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

// Delegates to canonical getVaultPath: consults VAULT_PATH env first (the
// inline implementation here never did), then cfg.vault_path. Returns null
// when unconfigured.
const readVaultRoot = getVaultPath;

function readInstalledPluginVersion(home) {
  const p = join(home, '.claude/plugins/installed_plugins.json');
  const data = readJsonSafe(p);
  const plugins = data?.plugins || data || {};
  const entries = plugins['learning-loop@learning-loop-marketplace'];
  return entries?.[0]?.version || null;
}

function readTemplateVersion() {
  try {
    const p = join(PLUGIN_DIR, 'templates/claudemd-section.version');
    return readFileSync(p, 'utf-8').trim();
  } catch {
    return '1';
  }
}

export async function runQuickChecks(ctx = {}) {
  const c = ctx;
  const checks = [
    quick.checkVaultPath({ vaultRoot: c.vaultRoot }),
    quick.checkVaultFolders({ vaultRoot: c.vaultRoot }),
    quick.checkVaultSystemFiles({ vaultRoot: c.vaultRoot }),
    quick.checkBinaryExists({ pluginData: c.pluginData, platform: c.platform }),
    quick.checkBinaryVersionFile({ pluginData: c.pluginData, pluginVersion: c.pluginVersion }),
    // Both of these accept an injected platform and neither was given one, so
    // the orchestrator resolved every win32 spelling from process.platform --
    // correct at runtime, unreachable from a POSIX runner. An absent c.platform
    // still falls through to each check's own default.
    quick.checkShimsExist({ home: c.home, platform: c.platform }),
    quick.checkLocalBinOnPath({ home: c.home, pathEnv: c.pathEnv }),
    quick.checkClaudemdSectionPresent({ home: c.home }),
    quick.checkClaudemdSectionCurrent({ home: c.home, templateVersion: c.templateVersion }),
    quick.checkInstalledPluginsReadable({ home: c.home }),
    quick.checkPluginCacheVersionPresent({ home: c.home, installedVersion: c.installedVersion }),
    quick.checkSearchIndexExists({ vaultRoot: c.vaultRoot }),
    quick.checkDupScanSocketFresh({ pluginData: c.pluginData }),
    quick.checkDuplicateGateHealth({ pluginData: c.pluginData, platform: c.platform }),
    quick.checkFederationSyncHealth({ pluginData: c.pluginData }),
    quick.checkHookErrors({ pluginData: c.pluginData }),
    quick.checkInjectionShadowGate({
      pluginData: c.pluginData,
      injectionMode: c.injectionMode,
      injectionNudge: c.injectionNudge,
    }),
    quick.checkAbiDrift({ abiDriftResult: c.abiDriftResult }),
    quick.checkOtelExportStatus({ pluginData: c.pluginData }),
    quick.checkOtelErrorLog({ pluginData: c.pluginData }),
  ];
  return {
    ts: new Date().toISOString(),
    ran: 'quick',
    checks,
  };
}

// Flags a justification index that has fallen behind the vault: edges.db
// missing entirely, or present with zero edges, while the vault has notes to
// classify. Pure formatter; the runner collects the inputs.
export function checkEdgesBackfill({ vaultNoteCount, dbExists, edgeCount, arguedEdgeCount } = {}) {
  if (!vaultNoteCount) {
    return makeCheck({
      id: 'edges-backfill',
      name: 'Edges index',
      status: SEVERITIES.ok,
      severity: SEVERITIES.warn,
      detail: 'no vault notes to index',
      fix: null,
    });
  }
  if (!dbExists) {
    return makeCheck({
      id: 'edges-backfill',
      name: 'Edges index',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: `edges.db missing while the vault has ${vaultNoteCount} note(s)`,
      fix: 'Run: node PLUGIN/scripts/backfill-edges.mjs',
    });
  }
  if (edgeCount === null) {
    return makeCheck({
      id: 'edges-backfill',
      name: 'Edges index',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: 'edges.db unreadable',
      fix: 'Run: node PLUGIN/scripts/backfill-edges.mjs',
    });
  }
  if (edgeCount === 0) {
    return makeCheck({
      id: 'edges-backfill',
      name: 'Edges index',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: `edges.db has zero edges while the vault has ${vaultNoteCount} note(s)`,
      fix: 'Run: node PLUGIN/scripts/backfill-edges.mjs',
    });
  }
  // edgeCount (all rows) decides the branches above: a comention-only vault
  // has a populated index and re-running backfill cannot change it, so it must
  // not fail here. arguedEdgeCount is display: the number this check has
  // always shown is how many argued edges the index holds.
  const argued = arguedEdgeCount ?? edgeCount;
  const comentions = edgeCount - argued;
  return makeCheck({
    id: 'edges-backfill',
    name: 'Edges index',
    status: SEVERITIES.ok,
    severity: SEVERITIES.warn,
    detail:
      comentions > 0
        ? `${argued} argued edge(s), ${comentions} co-mention(s)`
        : `${argued} edge(s)`,
    fix: null,
  });
}

// Flags contradiction cycles in the argumentation graph: notes that dispute
// each other in a loop. Knowledge state, not a dependency problem, so
// formatMissingDeps excludes this id; /health renders it. Pure formatter.
export function checkContradictionCycles({ dbExists, cycles } = {}) {
  if (!dbExists) {
    return makeCheck({
      id: 'contradiction-cycles',
      name: 'Contradiction cycles',
      status: SEVERITIES.ok,
      severity: SEVERITIES.warn,
      detail: 'no edges index to scan',
      fix: null,
    });
  }
  if (cycles == null) {
    // Same collector failure checkEdgesBackfill reports: the db exists but
    // could not be read. Healthy is the one thing that is not.
    return makeCheck({
      id: 'contradiction-cycles',
      name: 'Contradiction cycles',
      status: SEVERITIES.fail,
      severity: SEVERITIES.warn,
      detail: 'edges.db unreadable',
      fix: 'Run: node PLUGIN/scripts/backfill-edges.mjs',
    });
  }
  if (cycles.length === 0) {
    return makeCheck({
      id: 'contradiction-cycles',
      name: 'Contradiction cycles',
      status: SEVERITIES.ok,
      severity: SEVERITIES.warn,
      detail: 'no contradiction cycles',
      fix: null,
    });
  }
  const shown = cycles
    .slice(0, 3)
    .map((c) => [...c.nodes, c.nodes[0]].join(' -> '))
    .join('; ');
  const more = cycles.length > 3 ? ` (+${cycles.length - 3} more)` : '';
  return makeCheck({
    id: 'contradiction-cycles',
    name: 'Contradiction cycles',
    status: SEVERITIES.fail,
    severity: SEVERITIES.warn,
    detail: `${cycles.length} contradiction cycle(s): ${shown}${more}`,
    fix: 'Review with /learning-loop:gaps; full list: node PLUGIN/scripts/edges-cli.mjs cycles',
  });
}

async function collectEdgesBackfillInputs({ pluginData, vaultRoot }) {
  const vaultNoteCount = vaultRoot && existsSync(vaultRoot) ? listVaultNotes(vaultRoot).length : 0;
  const dbPath = pluginData ? DATA_FILES.edgesDb(pluginData) : null;
  const dbExists = Boolean(dbPath && existsSync(dbPath));
  let edgeCount = null;
  let arguedEdgeCount = null;
  let cycles = null;
  if (dbExists) {
    try {
      const { openEdgeDb, getContradictionGraphEdges } = await import('./lib/edges.mjs');
      const { findContradictionCycles } = await import('./lib/cycle-detect.mjs');
      const db = await openEdgeDb(dbPath);
      try {
        const res = db.exec(
          "SELECT COUNT(*), COALESCE(SUM(source_graph != 'comention'), 0) FROM edges",
        );
        edgeCount = res[0] ? Number(res[0].values[0][0]) : 0;
        arguedEdgeCount = res[0] ? Number(res[0].values[0][1]) : 0;
        cycles = findContradictionCycles(getContradictionGraphEdges(db));
      } finally {
        db.close();
      }
    } catch {
      edgeCount = null;
      arguedEdgeCount = null;
      cycles = null;
    }
  }
  return { vaultNoteCount, dbExists, edgeCount, arguedEdgeCount, cycles };
}

export async function runFullChecks(ctx = {}) {
  const c = ctx;
  const nodeVersionOutput = safeExec('node', ['-v']);
  const claudeVersionOutput = safeExec('claude', ['--version']);
  const installedPlugins = (() => {
    const data = readJsonSafe(join(c.home, '.claude/plugins/installed_plugins.json'));
    return data?.plugins || data || {};
  })();

  // c.platform, not process.platform: quick.mjs's checks already take an
  // injected platform, and this one silently did not -- so the full-check
  // binary path was the one win32 spelling a POSIX runner could never reach.
  // An absent c.platform falls through to binaryFileName's own default.
  const binaryPath = c.pluginData ? join(c.pluginData, 'bin', binaryFileName(c.platform)) : null;
  let binaryVersionOutput = null;
  let binaryExitCode = 127;
  if (binaryPath && existsSync(binaryPath)) {
    try {
      binaryVersionOutput = execFileSync(binaryPath, ['version'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      }).trim();
      binaryExitCode = 0;
    } catch (err) {
      binaryExitCode = err.status ?? 1;
    }
  }

  const pidfilePath = c.vaultRoot ? join(c.vaultRoot, '.vault-search/watch.pid') : null;
  const pidfileExists = pidfilePath ? existsSync(pidfilePath) : false;
  let pid = null;
  let pidIsAlive = false;
  if (pidfileExists) {
    try {
      pid = parseInt(readFileSync(pidfilePath, 'utf-8').trim(), 10);
      if (Number.isFinite(pid)) pidIsAlive = isProcessAlive(pid);
      // eslint-disable-next-line learning-loop/no-empty-catch -- readFileSync may throw if the pidfile vanishes between existsSync and read; treat as "no daemon" (pidIsAlive stays false).
    } catch {}
  }

  const edgesInputs = await collectEdgesBackfillInputs({
    pluginData: c.pluginData,
    vaultRoot: c.vaultRoot,
  });

  const quickResult = await runQuickChecks(ctx);
  const fullChecks = [
    full.checkNodeVersion({ nodeVersionOutput, minMajor: c.minNodeMajor || 22 }),
    full.checkClaudeVersion({ claudeVersionOutput, minVersion: c.minClaudeVersion || '2.1.144' }),
    full.checkPluginInstalled({
      pluginName: 'episodic-memory',
      marketplace: 'superpowers-marketplace',
      installedPlugins,
      severity: 'fail',
    }),
    full.checkPluginInstalled({
      pluginName: 'learning-loop',
      marketplace: 'learning-loop-marketplace',
      installedPlugins,
      severity: 'fail',
    }),
    full.checkBinaryRuns({ binaryVersionOutput, exitCode: binaryExitCode }),
    full.checkWatchDaemon({ pidfileExists, pidIsAlive, pid }),
    full.checkOfflineMode({ offline: isOffline() }),
    full.checkInvalidatedAdoption(full.collectInvalidatedAdoption(c.vaultRoot)),
    checkEdgesBackfill(edgesInputs),
    checkContradictionCycles(edgesInputs),
  ];

  return {
    ts: new Date().toISOString(),
    ran: 'full',
    checks: [...quickResult.checks, ...fullChecks],
  };
}

export function formatMissingDeps(result) {
  if (!result?.checks) return '';
  // injection-shadow-gate is a readiness nudge and contradiction-cycles is
  // knowledge state; neither is a missing dependency. The session-start
  // detector and /health surface those on their own lines.
  const failed = result.checks.filter(
    (c) =>
      c.status === 'fail' && c.id !== 'injection-shadow-gate' && c.id !== 'contradiction-cycles',
  );
  const required = failed.filter((c) => c.severity === 'fail');
  const optional = failed.filter((c) => c.severity === 'warn');
  if (failed.length === 0) return '';

  let out = '';
  if (required.length > 0) {
    out += '\n## Missing Required Dependencies\n';
    out += 'Learning-loop cannot function correctly without these.\n\n';
    for (const c of required) {
      out += `- **${c.name}**: ${c.detail}\n`;
      if (c.fix) out += `  Fix: \`${c.fix}\`\n`;
    }
  }
  if (optional.length > 0) {
    out += '\n## Missing Optional Dependencies\n';
    out += 'Recommended but not required.\n\n';
    for (const c of optional) {
      out += `- **${c.name}**: ${c.detail}\n`;
      if (c.fix) out += `  Fix: \`${c.fix}\`\n`;
    }
  }
  out += '\nRun /learning-loop:doctor for details.\n';
  return out;
}

function formatText({ checks }) {
  const icon = (c) => (c.status === 'ok' ? '✓' : c.severity === 'warn' ? '⚠' : '✗');
  const lines = checks.map((c) => {
    const fix = c.status !== 'ok' && c.fix ? `\n  → ${c.fix}` : '';
    return `${icon(c)} ${c.name.padEnd(28)} ${c.detail}${fix}`;
  });
  const fails = checks.filter((c) => c.status === 'fail' && c.severity === 'fail').length;
  const warns = checks.filter((c) => c.status === 'fail' && c.severity === 'warn').length;
  lines.push('');
  lines.push(`${fails} issue${fails === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}.`);
  return lines.join('\n');
}

// CLI entry
const isMain = isMainModule(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const wantFull = args.includes('--full');
  const wantJson = args.includes('--json');

  const home = env.HOME;
  const pluginData = resolvePluginData();
  const installedVersion = readInstalledPluginVersion(home) || '0.0.0';
  const ctx = {
    pluginData,
    vaultRoot: readVaultRoot(),
    home,
    pathEnv: env.PATH,
    installedVersion,
    pluginVersion: pluginVersion(),
    templateVersion: readTemplateVersion(),
    abiDriftResult: abiDriftSummary(),
    injectionMode: getConfig().injection_mode,
    injectionNudge: getConfig().injection_nudge,
    minNodeMajor: 22,
    minClaudeVersion: '2.1.144',
  };

  const result = wantFull ? await runFullChecks(ctx) : await runQuickChecks(ctx);
  if (wantJson) {
    process.stdout.write(JSON.stringify(result));
  } else {
    console.log(formatText(result));
  }
  const hasFails = result.checks.some((c) => c.status === 'fail' && c.severity === 'fail');
  process.exit(hasFails ? 1 : 0);
}
