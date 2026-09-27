// Full health checks: CLI invocations and external state.
// Each check is split into a pure function (accepts pre-collected inputs)
// and a runner-side I/O helper. This keeps the logic testable without
// shelling out and lets the CLI entry-point batch all spawns up front.

import { openSync, readSync, closeSync } from 'node:fs';
import { checker } from './types.mjs';
import { listVaultNotes } from '../vault-walk.mjs';
import { semverCmp } from '../semver.mjs';

export function checkNodeVersion({ nodeVersionOutput, minMajor } = {}) {
  const c = checker('node-version', 'Node.js', 'fail');
  if (!nodeVersionOutput) {
    return c.fail(
      'node not found',
      `Install Node ${minMajor}+ (curl -fsSL https://raw.githubusercontent.com/robinslange/learning-loop/main/install.sh | bash)`,
    );
  }
  const cleaned = String(nodeVersionOutput).trim().replace(/^v/, '');
  const major = parseInt(cleaned.split('.')[0], 10);
  if (Number.isNaN(major) || major < minMajor) {
    return c.fail(cleaned, `Upgrade to Node ${minMajor}+ (you have ${cleaned})`);
  }
  return c.ok(`v${cleaned}`);
}

export function checkClaudeVersion({ claudeVersionOutput, minVersion } = {}) {
  const c = checker('claude-version', 'Claude Code', 'fail');
  if (!claudeVersionOutput) {
    return c.fail(
      'claude not found',
      'Install Claude Code: curl -fsSL https://claude.ai/install.sh | bash',
    );
  }
  const m = String(claudeVersionOutput).match(/[0-9]+\.[0-9]+\.[0-9]+/);
  if (!m) {
    return c.fail('could not parse version', 'Reinstall Claude Code');
  }
  if (semverCmp(m[0], minVersion) < 0) {
    return c.fail(m[0], `Upgrade Claude Code to ${minVersion}+ (you have ${m[0]})`);
  }
  return c.ok(m[0]);
}

export function checkPluginInstalled({ pluginName, marketplace, installedPlugins } = {}) {
  const id =
    pluginName === 'episodic-memory' ? 'episodic-memory-installed' : 'learning-loop-installed';
  const c = checker(id, `${pluginName} plugin`, 'fail');
  const key = `${pluginName}@${marketplace}`;
  const entries = installedPlugins?.[key];
  if (!entries || entries.length === 0) {
    return c.fail('not installed', `claude plugin install ${key}`);
  }
  return c.ok(entries[0].version || 'unknown');
}

export function checkBinaryRuns({ binaryVersionOutput, exitCode } = {}) {
  const c = checker('binary-runs', 'll-search runs', 'fail');
  if (exitCode !== 0 || !binaryVersionOutput) {
    return c.fail(`exit ${exitCode}`, 'Run /learning-loop:init to re-download the binary');
  }
  return c.ok(String(binaryVersionOutput).trim().split('\n')[0]);
}

export function checkWatchDaemon({ pidfileExists, pidIsAlive, pid } = {}) {
  const c = checker('watch-daemon-status', 'Watch daemon', 'warn');
  if (!pidfileExists) {
    return c.ok('not running');
  }
  if (pidIsAlive) {
    return c.ok(`pid ${pid}`);
  }
  return c.fail(
    `pidfile claims pid ${pid} but process not running`,
    'Remove the stale pidfile, then run: ll-watch (no arguments)',
  );
}

// Reports LL_OFFLINE as an ACTIVE state, not a fault — an operator who set it
// for an air-gapped/update-controlled deployment can confirm the egress
// suppression is actually engaged rather than silently skipped.
export function checkOfflineMode({ offline } = {}) {
  const c = checker('offline-mode', 'Offline mode', 'warn');
  return c.ok(
    offline
      ? 'ON — update checks, binary auto-update, and web research suppressed'
      : 'off (LL_OFFLINE unset)',
  );
}

// Frontmatter sits at the top of a note; 2KB covers every real one and keeps
// this a bounded read per file rather than a full vault load.
const FRONTMATTER_PROBE_BYTES = 2048;
const INVALIDATED_RE = /^---\r?\n(?:(?!---\r?\n)[^\n]*\n)*?invalidated:/;

// Runner-side collector for checkInvalidatedAdoption: how many notes outside
// the excluded dirs carry `invalidated:` in their frontmatter.
export function collectInvalidatedAdoption(vaultRoot) {
  const notes = vaultRoot ? listVaultNotes(vaultRoot) : [];
  let invalidated = 0;
  const buf = Buffer.alloc(FRONTMATTER_PROBE_BYTES);
  for (const { path } of notes) {
    let fd;
    try {
      fd = openSync(path, 'r');
      const n = readSync(fd, buf, 0, FRONTMATTER_PROBE_BYTES, 0);
      if (INVALIDATED_RE.test(buf.toString('utf8', 0, n))) invalidated += 1;
    } catch {
      continue;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return { total: notes.length, invalidated };
}

// Adoption of the one supersession mechanism retrieval reads. Issue #66 found
// the key defined, honoured by enrichVaultHits, and present on 0 of 1,041
// notes because no writer produced it; this makes the count visible so a
// regression to zero is noticed rather than discovered by audit.
export function checkInvalidatedAdoption({ total = 0, invalidated = 0 } = {}) {
  const c = checker('invalidated-adoption', 'Invalidated notes', 'warn');
  return c.ok(`${invalidated} of ${total} notes carry invalidated:`);
}
