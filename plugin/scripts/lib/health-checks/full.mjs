// Full health checks: CLI invocations and external state.
// Each check is split into a pure function (accepts pre-collected inputs)
// and a runner-side I/O helper. This keeps the logic testable without
// shelling out and lets the CLI entry-point batch all spawns up front.

import { CHECK_IDS, SEVERITIES, makeCheck } from './types.mjs';

function semverGe(a, b) {
  const pa = String(a)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  const pb = String(b)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return true;
}

export function checkNodeVersion({ nodeVersionOutput, minMajor } = {}) {
  if (!nodeVersionOutput) {
    return makeCheck({
      id: CHECK_IDS['node-version'],
      name: 'Node.js',
      status: SEVERITIES.fail,
      severity: SEVERITIES.fail,
      detail: 'node not found',
      fix: `Install Node ${minMajor}+ (curl -fsSL https://raw.githubusercontent.com/robinslange/learning-loop/main/install.sh | bash)`,
    });
  }
  const cleaned = String(nodeVersionOutput).trim().replace(/^v/, '');
  const major = parseInt(cleaned.split('.')[0], 10);
  if (Number.isNaN(major) || major < minMajor) {
    return makeCheck({
      id: CHECK_IDS['node-version'],
      name: 'Node.js',
      status: SEVERITIES.fail,
      severity: SEVERITIES.fail,
      detail: cleaned,
      fix: `Upgrade to Node ${minMajor}+ (you have ${cleaned})`,
    });
  }
  return makeCheck({
    id: CHECK_IDS['node-version'],
    name: 'Node.js',
    status: SEVERITIES.ok,
    severity: SEVERITIES.fail,
    detail: `v${cleaned}`,
    fix: null,
  });
}

export function checkClaudeVersion({ claudeVersionOutput, minVersion } = {}) {
  if (!claudeVersionOutput) {
    return makeCheck({
      id: CHECK_IDS['claude-version'],
      name: 'Claude Code',
      status: SEVERITIES.fail,
      severity: SEVERITIES.fail,
      detail: 'claude not found',
      fix: 'Install Claude Code: curl -fsSL https://claude.ai/install.sh | bash',
    });
  }
  const m = String(claudeVersionOutput).match(/[0-9]+\.[0-9]+\.[0-9]+/);
  if (!m) {
    return makeCheck({
      id: CHECK_IDS['claude-version'],
      name: 'Claude Code',
      status: SEVERITIES.fail,
      severity: SEVERITIES.fail,
      detail: 'could not parse version',
      fix: 'Reinstall Claude Code',
    });
  }
  if (!semverGe(m[0], minVersion)) {
    return makeCheck({
      id: CHECK_IDS['claude-version'],
      name: 'Claude Code',
      status: SEVERITIES.fail,
      severity: SEVERITIES.fail,
      detail: m[0],
      fix: `Upgrade Claude Code to ${minVersion}+ (you have ${m[0]})`,
    });
  }
  return makeCheck({
    id: CHECK_IDS['claude-version'],
    name: 'Claude Code',
    status: SEVERITIES.ok,
    severity: SEVERITIES.fail,
    detail: m[0],
    fix: null,
  });
}

export function checkPluginInstalled({ pluginName, marketplace, installedPlugins, severity } = {}) {
  const id =
    pluginName === 'episodic-memory'
      ? CHECK_IDS['episodic-memory-installed']
      : CHECK_IDS['learning-loop-installed'];
  const key = `${pluginName}@${marketplace}`;
  const entries = installedPlugins?.[key];
  if (!entries || entries.length === 0) {
    return makeCheck({
      id,
      name: `${pluginName} plugin`,
      status: SEVERITIES.fail,
      severity: severity || SEVERITIES.fail,
      detail: 'not installed',
      fix: `claude plugin install ${key}`,
    });
  }
  return makeCheck({
    id,
    name: `${pluginName} plugin`,
    status: SEVERITIES.ok,
    severity: severity || SEVERITIES.fail,
    detail: entries[0].version || 'unknown',
    fix: null,
  });
}

export function checkBinaryRuns({ binaryVersionOutput, exitCode } = {}) {
  if (exitCode !== 0 || !binaryVersionOutput) {
    return makeCheck({
      id: CHECK_IDS['binary-runs'],
      name: 'll-search runs',
      status: SEVERITIES.fail,
      severity: SEVERITIES.fail,
      detail: `exit ${exitCode}`,
      fix: 'Run /learning-loop:init to re-download the binary',
    });
  }
  return makeCheck({
    id: CHECK_IDS['binary-runs'],
    name: 'll-search runs',
    status: SEVERITIES.ok,
    severity: SEVERITIES.fail,
    detail: String(binaryVersionOutput).trim().split('\n')[0],
    fix: null,
  });
}

export function checkWatchDaemon({ pidfileExists, pidIsAlive, pid } = {}) {
  if (!pidfileExists) {
    return makeCheck({
      id: CHECK_IDS['watch-daemon-status'],
      name: 'Watch daemon',
      status: SEVERITIES.ok,
      severity: SEVERITIES.warn,
      detail: 'not running',
      fix: null,
    });
  }
  if (pidIsAlive) {
    return makeCheck({
      id: CHECK_IDS['watch-daemon-status'],
      name: 'Watch daemon',
      status: SEVERITIES.ok,
      severity: SEVERITIES.warn,
      detail: `pid ${pid}`,
      fix: null,
    });
  }
  return makeCheck({
    id: CHECK_IDS['watch-daemon-status'],
    name: 'Watch daemon',
    status: SEVERITIES.fail,
    severity: SEVERITIES.warn,
    detail: `pidfile claims pid ${pid} but process not running`,
    fix: 'Remove the stale pidfile, then run: ll-watch (no arguments)',
  });
}

// Reports LL_OFFLINE as an ACTIVE state, not a fault — an operator who set it
// for an air-gapped/update-controlled deployment can confirm the egress
// suppression is actually engaged rather than silently skipped.
export function checkOfflineMode({ offline } = {}) {
  return makeCheck({
    id: CHECK_IDS['offline-mode'],
    name: 'Offline mode',
    status: SEVERITIES.ok,
    severity: SEVERITIES.warn,
    detail: offline
      ? 'ON — update checks, binary auto-update, and web research suppressed'
      : 'off (LL_OFFLINE unset)',
    fix: null,
  });
}
