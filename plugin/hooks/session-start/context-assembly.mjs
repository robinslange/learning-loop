// hooks/session-start/context-assembly.mjs : build the additionalContext string.
// Reads update-check cache, memory indices, intention summary, dream gate,
// learned patterns, and federation status. Mutates ctx.context.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, basename, resolve } from 'node:path';
import { readMarker, MARKER_PATHS } from '../../scripts/lib/marker-cache.mjs';
import { safeLoad } from '../../scripts/lib/safe-load.mjs';
import { HookConfig } from '../../scripts/lib/hook-config.mjs';
import { logError } from '../../scripts/lib/log.mjs';
import { env } from '../../scripts/lib/env.mjs';
import { DATA_PATHS, FEDERATION_PATHS } from '../../scripts/lib/paths.mjs';
import { recordDetachedChild } from '../lib/common.mjs';

const MEMORY_RECENCY_MS = 7 * 24 * 60 * 60 * 1000;

function memoryIsFresh(path) {
  if (env.LEARNING_LOOP_ALWAYS_INJECT_MEMORY) return true;
  try {
    return Date.now() - statSync(path).mtimeMs <= MEMORY_RECENCY_MS;
  } catch {
    return false;
  }
}

const MEM_CAP = HookConfig.MEMORY_INDEX_MAX_BYTES;

// Read a memory index capped at MEM_CAP bytes. Oversized files are cut at the
// last full line and tagged with a pointer to the full file, so the assembled
// SessionStart context stays within the hook stdout budget instead of relying
// on emitJson's blind backstop trim.
function readMemoryIndexCapped(path) {
  const raw = readFileSync(path, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') <= MEM_CAP) return raw.trim();
  let head = raw.slice(0, MEM_CAP);
  while (Buffer.byteLength(head, 'utf8') > MEM_CAP) head = head.slice(0, -1);
  const cut = head.lastIndexOf('\n');
  if (cut > 0) head = head.slice(0, cut);
  return `${head.trim()}\n[truncated — full index at ${path}]`;
}

export async function run(ctx) {
  const {
    pluginDir,
    pluginData,
    vaultRoot,
    projectDir,
    memoryDir,
    updateCacheFile,
    depsAllSatisfied,
    depsMissing,
  } = ctx;

  const VAULT_INBOX = join(vaultRoot, '0-inbox');
  const searchCmd = `node ${join(pluginDir, 'scripts', 'vault-search.mjs')}`;

  // 0.5. Inject resolved paths for skill consumption.
  ctx.context += `## Learning Loop Paths\n`;
  ctx.context += `PLUGIN=${pluginDir}\n`;
  ctx.context += `PLUGIN_DATA=${pluginData}\n`;
  ctx.context += `VAULT=${vaultRoot}\n`;

  // 0.6. Update notification from cached check.
  if (updateCacheFile) {
    try {
      const { value: cached } = safeLoad(updateCacheFile, { fallback: null });
      if (cached?.update_available) {
        ctx.context += `\n## Plugin Update Available\n`;
        ctx.context += `learning-loop ${cached.installed} → ${cached.latest}. Run \`/learning-loop:init\` to update.\n`;
      }
    } catch (err) {
      logError('session-start.context-assembly.updateCache', err);
    }
  }

  // 1. Detect project from working directory.
  if (projectDir) {
    ctx.context += `Current project: ${basename(projectDir)}\n`;
  }

  if (depsMissing) {
    ctx.context += depsMissing;
  }

  // 2. Project-specific auto-memory.
  if (projectDir) {
    const encodedPath = projectDir.replace(/[/\\]/g, '-');
    const memoryIndex = join(memoryDir, encodedPath, 'memory', 'MEMORY.md');
    if (existsSync(memoryIndex) && memoryIsFresh(memoryIndex)) {
      try {
        const index = readMemoryIndexCapped(memoryIndex);
        if (index) {
          ctx.context += `\n## Auto-memory index for this project:\n${index}\n`;
        }
      } catch (err) {
        logError('session-start.context-assembly.projectMemory', err);
      }
    }
  }

  // 3. Global memory (keyed to vault parent).
  const vaultParent = resolve(vaultRoot, '..');
  const encodedVaultParent = vaultParent.replace(/[/\\]/g, '-');
  const globalMemory = join(memoryDir, encodedVaultParent, 'memory', 'MEMORY.md');
  if (existsSync(globalMemory) && memoryIsFresh(globalMemory)) {
    try {
      const globalIndex = readMemoryIndexCapped(globalMemory);
      if (globalIndex) {
        ctx.context += `\n## Global memory index:\n${globalIndex}\n`;
      }
    } catch (err) {
      logError('session-start.context-assembly.globalMemory', err);
    }
  }

  // 4. On-demand vault captures pointer.
  ctx.context += '\n## Recent vault captures\n';
  ctx.context += `Run \`ls -t ${VAULT_INBOX} | head -5\` or \`${searchCmd} search "<topic>"\` for relevant notes.\n`;

  // 5. Intention summary — read cached marker; refresh in background.
  // pluginData required: the worker resolves PLUGIN_DATA from the same source
  // (config.mjs reads CLAUDE_PLUGIN_DATA). A fallback to pluginDir would
  // produce a different path than the worker writes to.
  if (pluginData) {
    try {
      const cached = readMarker(MARKER_PATHS.intentions(pluginData));
      if (Array.isArray(cached) && cached.length > 0) {
        ctx.context += '\n## Notes with active intentions:\n';
        for (const item of cached) {
          ctx.context += `- ${item.context} (${item.count} notes)\n`;
        }
        ctx.context += `\nTo see notes for a specific context: node ${join(pluginDir, 'scripts', 'vault-search.mjs')} intentions "<context name>"\n`;
      }
      // Kick off detached refresh; the worker derives the marker path from PLUGIN_DATA itself.
      const child = spawn(
        'node',
        [join(pluginDir, 'scripts', 'vault-search.mjs'), 'intentions', '--session-start-refresh'],
        { detached: true, stdio: 'ignore' },
      );
      child.on('error', () => {}); // detached fire-and-forget; error is expected-silent
      child.unref();
      recordDetachedChild(child.pid);
    } catch (err) {
      logError('session-start.context-assembly.intentions', err);
    }
  }

  // 6. Retrieval protocol footer.
  ctx.context += '\n## Learning Loop — Retrieval Protocol\n';
  ctx.context +=
    "You have a learning loop active. Before responding to the user's first message:\n";
  ctx.context +=
    '1. Check if any auto-memories (listed above) are relevant to the task at hand. If so, read them.\n';
  if (depsAllSatisfied) {
    ctx.context +=
      '2. Search episodic memory for relevant past conversations about this topic/project.\n';
  } else {
    ctx.context += '2. (Skipped — episodic memory plugin not installed. Run /init to set up.)\n';
  }
  ctx.context += `3. Search the Obsidian vault — use \`${searchCmd} search "<topic>"\` for semantic matches, \`Grep\` for keyword matches.\n`;
  ctx.context += `4. Check the intention summary above (if present). For relevant contexts, drill in with \`${searchCmd} intentions "<context>"\` to see specific notes and cues.\n`;
  ctx.context +=
    "5. Surface relevant findings in a single line prefixed with 'Recall:' or 'Transfer:'\n";
  ctx.context += '6. When corrected, immediately save to auto-memory as feedback. No delay.\n';
  ctx.context += '7. After substantial work, suggest /reflect to consolidate learnings.\n';
  ctx.context += 'Keep retrieval lightweight — one line per insight, not a wall of text.\n';

  // 7. Dream gate check — read cached marker; refresh in background.
  if (pluginData) {
    try {
      const cached = readMarker(MARKER_PATHS.dreamGate(pluginData));
      if (cached?.nudge) {
        ctx.context += `\n## Dream Consolidation Due\n${cached.nudge}\n`;
      }
      const child = spawn(
        'node',
        [join(import.meta.dirname, '..', 'lib', 'dream-gate.js'), '--session-start-refresh'],
        { detached: true, stdio: 'ignore' },
      );
      child.on('error', () => {}); // detached fire-and-forget; error is expected-silent
      child.unref();
      recordDetachedChild(child.pid);
    } catch (err) {
      logError('session-start.context-assembly.dreamGate', err);
    }
  }

  // 7.5. Learned patterns.
  if (pluginData) {
    const patternsFile = join(DATA_PATHS.provenance(pluginData), 'learned-patterns.md');
    if (existsSync(patternsFile)) {
      try {
        const patternsContent = readFileSync(patternsFile, 'utf8');
        const patternCount = (patternsContent.match(/^\d+\./gm) || []).length;
        if (patternCount > 0) {
          ctx.context += `\n## Learned Patterns (from verification feedback)\n${patternsContent}\n`;
        }
      } catch (err) {
        logError('session-start.context-assembly.learnedPatterns', err);
      }
    }

    // 7.6. Federation status.
    try {
      const fedConfigPath = FEDERATION_PATHS.config(pluginData);
      if (existsSync(fedConfigPath)) {
        const peersDir = FEDERATION_PATHS.peersDir(pluginData);
        if (existsSync(peersDir)) {
          const peerNames = readdirSync(peersDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
          if (peerNames.length > 0) {
            ctx.context += '\n## Federation\n';
            ctx.context += `Connected peers: ${peerNames.join(', ')}. Search results include peer knowledge.\n`;
          }
        }
      }
    } catch (err) {
      logError('session-start.context-assembly.federation', err);
    }
  }

  // 10. Emit session-start provenance event — fire and forget.
  try {
    const child = spawn(
      'node',
      [
        join(pluginDir, 'scripts', 'provenance.mjs'),
        JSON.stringify({
          agent: 'session',
          action: 'session-start',
          source: 'hook',
        }),
      ],
      { detached: true, stdio: 'ignore' },
    );
    child.on('error', () => {}); // detached fire-and-forget; error is expected-silent
    child.unref();
    recordDetachedChild(child.pid);
  } catch (err) {
    logError('session-start.context-assembly.provenance', err);
  }
}
