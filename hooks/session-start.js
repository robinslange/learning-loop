#!/usr/bin/env node
// Learning Loop — SessionStart hook
// Injects context from auto-memory and recent Obsidian captures to prime retrieval.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { home, resolvePluginData, resolveVaultPath, findBinary as findBinaryShared } from './lib/common.mjs';

const PLUGIN_DIR = resolve(import.meta.dirname, '..');

// Clean stale plugin cache versions (only keep current)
try {
  const cacheParent = resolve(PLUGIN_DIR, '..');
  const currentVersion = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf-8')).version;
  for (const entry of readdirSync(cacheParent)) {
    if (entry !== currentVersion && /^\d+\.\d+\.\d+$/.test(entry)) {
      rmSync(join(cacheParent, entry), { recursive: true, force: true });
    }
  }
} catch {}
const tmp = tmpdir();

const MEMORY_DIR = join(home(), '.claude', 'projects');

let vaultRoot = resolveVaultPath();
if (!vaultRoot) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' } }));
  process.exit(0);
}
const VAULT_INBOX = join(vaultRoot, '0-inbox');

// Check plugin dependencies
let depsAllSatisfied = true;
let depsMissing = '';
try {
  const depOutput = execFileSync(
    'node',
    [join(PLUGIN_DIR, 'scripts', 'check-deps.mjs')],
    { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] }
  ).trim();

  if (depOutput && depOutput !== '{}') {
    const deps = JSON.parse(depOutput);
    const issues = Object.entries(deps).filter(([, v]) => v.status !== 'installed');
    if (issues.length > 0) {
      depsAllSatisfied = false;
      depsMissing += '\n## Missing Dependencies\n';
      for (const [name, info] of issues) {
        depsMissing += `- **${name}** (${info.status}): \`claude plugin install ${name}@${info.marketplace}\`\n`;
        if (info.reason) depsMissing += `  Required for: ${info.reason}\n`;
      }
      depsMissing += '\nRun `/init` to set up all dependencies.\n';
    }
  }
} catch {}

// Apply config tokens if needed (runs once after install/update)
const configMarker = join(PLUGIN_DIR, '.config-applied');
const pluginData = resolvePluginData();
try {
  const pluginDataConfig = pluginData ? join(pluginData, 'config.json') : null;
  const legacyConfig = join(PLUGIN_DIR, 'config.json');
  const activeConfig = (pluginDataConfig && existsSync(pluginDataConfig)) ? pluginDataConfig : legacyConfig;
  const configExists = existsSync(activeConfig);
  const markerExists = existsSync(configMarker);
  const configNewer =
    configExists && markerExists && statSync(activeConfig).mtimeMs > statSync(configMarker).mtimeMs;
  if (!markerExists || configNewer) {
    execFileSync('node', [join(PLUGIN_DIR, 'scripts', 'apply-config.mjs')], { stdio: 'ignore' });
    writeFileSync(configMarker, '');
  }
} catch {}

// 0. Incremental reindex (fast: 39ms no-op, <500ms with changes)
const DB_DIR = join(vaultRoot, '.vault-search');
const DB_PATH = join(DB_DIR, 'vault-index.db');

function isWatchRunning() {
  if (!pluginData) return false;
  try {
    const pid = parseInt(readFileSync(join(pluginData, 'watch.pid'), 'utf8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

const binary = findBinaryShared();
if (binary && existsSync(DB_PATH) && !isWatchRunning()) {
  try {
    execFileSync(binary.bin, ['index', vaultRoot, DB_PATH], {
      timeout: 5000,
      stdio: 'ignore',
      env: { ...process.env, ORT_DYLIB_PATH: binary.binDir, ORT_LIB_LOCATION: binary.binDir },
    });
  } catch {}
}

let context = '';

// 0.5. Inject resolved paths for skill consumption
context += `## Learning Loop Paths\n`;
context += `PLUGIN=${PLUGIN_DIR}\n`;
context += `PLUGIN_DATA=${pluginData}\n`;
context += `VAULT=${vaultRoot}\n`;

// 1. Detect project from working directory
const projectDir = process.env.CLAUDE_PROJECT_DIR || '';
if (projectDir) {
  context += `Current project: ${basename(projectDir)}\n`;
}

if (depsMissing) {
  context += depsMissing;
}

// 2. Find project-specific auto-memory directory
if (projectDir) {
  const encodedPath = projectDir.replace(/[/\\]/g, '-');
  const memoryDir = join(MEMORY_DIR, encodedPath, 'memory');
  const memoryIndex = join(memoryDir, 'MEMORY.md');
  if (existsSync(memoryIndex)) {
    try {
      const index = readFileSync(memoryIndex, 'utf8').trim();
      if (index) {
        context += `\n## Auto-memory index for this project:\n${index}\n`;
      }
    } catch {}
  }
}

// 3. Also check global memory (user-level, keyed to vault parent)
const vaultParent = resolve(vaultRoot, '..');
const encodedVaultParent = vaultParent.replace(/[/\\]/g, '-');
const globalMemory = join(MEMORY_DIR, encodedVaultParent, 'memory', 'MEMORY.md');
if (existsSync(globalMemory)) {
  try {
    const globalIndex = readFileSync(globalMemory, 'utf8').trim();
    if (globalIndex) {
      context += `\n## Global memory index:\n${globalIndex}\n`;
    }
  } catch {}
}

// 4. Recent Obsidian inbox captures (last 5 by modification time)
if (existsSync(VAULT_INBOX)) {
  try {
    const notes = readdirSync(VAULT_INBOX)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({
        name: f,
        mtime: statSync(join(VAULT_INBOX, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5);

    if (notes.length > 0) {
      context += '\n## Recent vault captures (0-inbox, newest first):\n';
      for (const note of notes) {
        context += `- ${basename(note.name, '.md')}\n`;
      }
    }
  } catch {}
}

// 5. Build intention summary
try {
  const intentionOutput = execFileSync(
    'node',
    [join(PLUGIN_DIR, 'scripts', 'vault-search.mjs'), 'intentions'],
    { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'ignore'] }
  ).trim();

  if (intentionOutput && intentionOutput !== '[]') {
    const data = JSON.parse(intentionOutput);
    if (Array.isArray(data) && data.length > 0) {
      context += '\n## Notes with active intentions:\n';
      for (const item of data) {
        context += `- ${item.context} (${item.count} notes)\n`;
      }
      context += `\nTo see notes for a specific context: node ${join(PLUGIN_DIR, 'scripts', 'vault-search.mjs')} intentions "<context name>"\n`;
    }
  }
} catch {}

// 6. Output retrieval cue
const searchCmd = `node ${join(PLUGIN_DIR, 'scripts', 'vault-search.mjs')}`;
context += '\n## Learning Loop — Retrieval Protocol\n';
context += 'You have a learning loop active. Before responding to the user\'s first message:\n';
context += '1. Check if any auto-memories (listed above) are relevant to the task at hand. If so, read them.\n';
if (depsAllSatisfied) {
  context += '2. Search episodic memory for relevant past conversations about this topic/project.\n';
} else {
  context += '2. (Skipped — episodic memory plugin not installed. Run /init to set up.)\n';
}
context += `3. Search the Obsidian vault — use \`${searchCmd} search "<topic>"\` for semantic matches, mgrep for keyword matches.\n`;
context += `4. Check the intention summary above (if present). For relevant contexts, drill in with \`${searchCmd} intentions "<context>"\` to see specific notes and cues.\n`;
context += '5. Surface relevant findings in a single line prefixed with \'Recall:\' or \'Transfer:\'\n';
context += '6. When corrected, immediately save to auto-memory as feedback. No delay.\n';
context += '7. After substantial work, suggest /reflect to consolidate learnings.\n';
context += 'Keep retrieval lightweight — one line per insight, not a wall of text.\n';

// 7. Dream gate check
try {
  const dreamNudge = execFileSync(
    'node',
    [join(import.meta.dirname, 'dream-gate.js')],
    { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] }
  ).trim();
  if (dreamNudge) {
    context += `\n## Dream Consolidation Due\n${dreamNudge}\n`;
  }
} catch {}

// 7.5. Inject learned patterns if they exist
const PROVENANCE_DIR = join(
  pluginData,
  'provenance'
);
const patternsFile = join(PROVENANCE_DIR, 'learned-patterns.md');
if (existsSync(patternsFile)) {
  try {
    const patternsContent = readFileSync(patternsFile, 'utf8');
    const patternCount = (patternsContent.match(/^\d+\./gm) || []).length;
    if (patternCount > 0) {
      context += `\n## Learned Patterns (from verification feedback)\n${patternsContent}\n`;
    }
  } catch {}
}

// 7.6. Federation status
try {
  const fedConfigPath = join(pluginData, 'federation', 'config.json');
  if (existsSync(fedConfigPath)) {
    const fedConfig = JSON.parse(readFileSync(fedConfigPath, 'utf-8'));
    const peersDir = join(pluginData, 'federation', 'data', 'peers');
    let peerInfo = [];

    if (existsSync(peersDir)) {
      for (const entry of readdirSync(peersDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const metaPath = join(peersDir, entry.name, 'index.db.meta');
        if (existsSync(metaPath)) {
          try {
            const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
            peerInfo.push({ id: entry.name, notes: meta.note_count || '?', updated: meta.updated_at || 'unknown' });
          } catch {}
        }
      }
    }

    if (peerInfo.length > 0) {
      context += '\n## Federation\n';
      context += `Connected peers: ${peerInfo.length}. Search results automatically include peer knowledge.\n`;
      for (const p of peerInfo) {
        context += `- ${p.id}: ${p.notes} notes (last sync: ${p.updated})\n`;
      }

      const oneHourAgo = Date.now() - 3600000;
      const allStale = peerInfo.every(p => {
        const ts = new Date(p.updated).getTime();
        return isNaN(ts) || ts < oneHourAgo;
      });
      if (allStale) {
        context += '\nFederation indexes may be stale. Run `node vault-search.mjs sync` to refresh.\n';
      }
    }
  }
} catch {}

// 8. Record session start time and snapshot memory file list
const sessionId = randomBytes(4).toString('hex');
writeFileSync(join(tmp, 'learning-loop-session-start'), String(Math.floor(Date.now() / 1000)));
if (projectDir) {
  const encodedPath = projectDir.replace(/[/\\]/g, '-');
  const memDir = join(MEMORY_DIR, encodedPath, 'memory');
  try {
    const files = readdirSync(memDir).filter((f) => f.endsWith('.md'));
    writeFileSync(join(tmp, 'learning-loop-memory-snapshot'), JSON.stringify(files));
    // Persist retrieval snapshot for /dream decay tracking
    try {
      const retrievalDir = join(pluginData, 'retrieval');
      mkdirSync(retrievalDir, { recursive: true });
      const entry = JSON.stringify({
        ts: new Date().toISOString(),
        session_id: sessionId,
        memories: files,
      });
      appendFileSync(join(retrievalDir, `access-${new Date().toISOString().slice(0, 7)}.jsonl`), entry + '\n');
    } catch {}
  } catch {}
}

// 9. Write session ID
writeFileSync(join(tmp, 'learning-loop-session-id'), sessionId);

// 10. Emit session-start provenance event
try {
  execFileSync(
    'node',
    [join(PLUGIN_DIR, 'scripts', 'provenance.mjs'), JSON.stringify({ agent: 'session', action: 'session-start', source: 'hook' })],
    { timeout: 3000, stdio: 'ignore' }
  );
} catch {}

// Output as JSON for additionalContext injection
const output = {
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: context,
  },
};

process.stdout.write(JSON.stringify(output));
