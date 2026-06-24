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

// Cap a variable-size context section at MEM_CAP bytes. Oversized content is
// cut at the last full line and tagged with a pointer line, so the assembled
// SessionStart context stays within the hook stdout budget instead of relying
// on emitJson's blind backstop trim.
function capSection(text, pointer) {
  if (Buffer.byteLength(text, 'utf8') <= MEM_CAP) return text.trim();
  let head = text.slice(0, MEM_CAP);
  while (Buffer.byteLength(head, 'utf8') > MEM_CAP) head = head.slice(0, -1);
  const cut = head.lastIndexOf('\n');
  if (cut > 0) head = head.slice(0, cut);
  return `${head.trim()}\n${pointer}`;
}

// Memory index injection. When the index fits under the cap, inject it whole —
// every line carries signal. When it overflows, inject a pointer instead of an
// unranked byte-prefix: a 3KB slice of a 200KB file is the first ~1% of entries
// in raw /dream write-order, not a ranked menu, so it costs ~720 tokens for
// near-zero retrieval value. The Retrieval Protocol already instructs the model
// to read indexes it deems relevant — the pointer tells it where and how big.
function readMemoryIndexCapped(path) {
  const raw = readFileSync(path, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') <= MEM_CAP) return raw.trim();
  const entryCount = (raw.match(/^\s*-\s/gm) || []).length;
  return `${entryCount} entries — read ${path} or \`grep\` it when a task looks relevant. [truncated — full index at ${path}]`;
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

  // 2. Retrieval protocol. Emitted BEFORE the variable-size sections (memory
  // indexes, learned patterns, intentions): emitJson trims oversized
  // additionalContext from the TAIL, so behavior-defining instructions must
  // sit ahead of the bulk that could push the payload past the stdout cap.
  // Every variable-size section below is byte-capped via capSection, and the
  // memory indexes are assembled first among them so a backstop trim evicts
  // the lower-value tail (patterns, intentions) before the index lines.
  //
  // NOTE: this protocol mirrors the static "Learning Loop" section /init
  // installs into the user's CLAUDE.md. The template in
  // plugin/skills/init/phases/05-claudemd.md is the source of truth — keep
  // command names and steps in sync with it (always the namespaced
  // /learning-loop:* forms, never bare /init or /reflect).
  ctx.context += '\n## Learning Loop — Retrieval Protocol\n';
  ctx.context +=
    "You have a learning loop active. Before responding to the user's first message:\n";
  ctx.context +=
    '1. Check if any auto-memory indexes (listed below, if present) are relevant to the task at hand. If so, read them.\n';
  if (depsAllSatisfied) {
    ctx.context +=
      '2. Search episodic memory for relevant past conversations about this topic/project.\n';
  } else {
    ctx.context +=
      '2. (Skipped — episodic memory plugin not installed. Run /learning-loop:init to set up.)\n';
  }
  ctx.context += `3. Search the Obsidian vault — use \`${searchCmd} search "<topic>"\` for semantic matches, \`Grep\` for keyword matches.\n`;
  ctx.context += `4. Check the intention summary below (if present). For relevant contexts, drill in with \`${searchCmd} intentions "<context>"\` to see specific notes and cues.\n`;
  ctx.context +=
    "5. Surface relevant findings in a single line prefixed with 'Recall:' or 'Transfer:'\n";
  ctx.context += '6. When corrected, immediately save to auto-memory as feedback. No delay.\n';
  ctx.context +=
    '7. After substantial work, suggest /learning-loop:reflect to consolidate learnings.\n';
  ctx.context += 'Keep retrieval lightweight — one line per insight, not a wall of text.\n';

  // 3. Dream gate check — read cached marker; refresh in background.
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

  // 4. Project-specific auto-memory. Capped memory indexes come right after
  // the protocol so an oversized payload evicts later, lower-value sections
  // instead of the index lines.
  let projectMemoryIndex = null;
  if (projectDir) {
    const encodedPath = projectDir.replace(/[/\\]/g, '-');
    projectMemoryIndex = join(memoryDir, encodedPath, 'memory', 'MEMORY.md');
    if (existsSync(projectMemoryIndex) && memoryIsFresh(projectMemoryIndex)) {
      try {
        const index = readMemoryIndexCapped(projectMemoryIndex);
        if (index) {
          ctx.context += `\n## Auto-memory index for this project:\n${index}\n`;
        }
      } catch (err) {
        logError('session-start.context-assembly.projectMemory', err);
      }
    }
  }

  // 5. Global memory (keyed to vault parent). When the project IS the vault
  // parent both keys resolve to the same MEMORY.md — skip the global section
  // rather than injecting the identical index twice.
  const vaultParent = resolve(vaultRoot, '..');
  const encodedVaultParent = vaultParent.replace(/[/\\]/g, '-');
  const globalMemory = join(memoryDir, encodedVaultParent, 'memory', 'MEMORY.md');
  if (
    globalMemory !== projectMemoryIndex &&
    existsSync(globalMemory) &&
    memoryIsFresh(globalMemory)
  ) {
    try {
      const globalIndex = readMemoryIndexCapped(globalMemory);
      if (globalIndex) {
        ctx.context += `\n## Global memory index:\n${globalIndex}\n`;
      }
    } catch (err) {
      logError('session-start.context-assembly.globalMemory', err);
    }
  }

  // 6. Learned patterns — capped like the memory indexes.
  if (pluginData) {
    const patternsFile = join(DATA_PATHS.provenance(pluginData), 'learned-patterns.md');
    if (existsSync(patternsFile)) {
      try {
        const patternsContent = readFileSync(patternsFile, 'utf8');
        const patternCount = (patternsContent.match(/^\d+\./gm) || []).length;
        if (patternCount > 0) {
          const patterns = capSection(
            patternsContent,
            `[truncated — full file at ${patternsFile}]`,
          );
          ctx.context += `\n## Learned Patterns (from verification feedback)\n${patterns}\n`;
        }
      } catch (err) {
        logError('session-start.context-assembly.learnedPatterns', err);
      }
    }

    // 7. Federation status.
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

  // 8. On-demand vault captures pointer.
  ctx.context += '\n## Recent vault captures\n';
  ctx.context += `Run \`ls -t ${VAULT_INBOX} | head -5\` or \`${searchCmd} search "<topic>"\` for relevant notes.\n`;

  // 9. Intention summary — read cached marker; refresh in background. The
  // rendered list is capped: the marker array is unbounded (one line per
  // intention context), and an oversized list must not evict earlier sections.
  // pluginData required: the worker resolves PLUGIN_DATA from the same source
  // (config.mjs reads CLAUDE_PLUGIN_DATA). A fallback to pluginDir would
  // produce a different path than the worker writes to.
  if (pluginData) {
    try {
      const cached = readMarker(MARKER_PATHS.intentions(pluginData));
      if (Array.isArray(cached) && cached.length > 0) {
        let list = '';
        for (const item of cached) {
          list += `- ${item.context} (${item.count} notes)\n`;
        }
        ctx.context += '\n## Notes with active intentions:\n';
        ctx.context += `${capSection(list, `[truncated — run \`${searchCmd} intentions\` for the full list]`)}\n`;
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
