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
import { DATA_PATHS, FEDERATION_PATHS, encodeProjectDir } from '../../scripts/lib/paths.mjs';
import { recordDetachedChild, emitProvenance, home } from '../lib/common.mjs';
import { wrapRetrievalText } from '../../scripts/lib/origin-envelope.mjs';
import { writeRetrieval } from '../../scripts/lib/retrieval.mjs';

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

const STALE_AFTER = 7 * 86400;

/**
 * One line about a vault's federation, or null when there is genuinely nothing
 * to say.
 *
 * A line printed every session regardless is a line nobody reads, which is how
 * a two-month outage stayed invisible: the client was content and said so at
 * length. So a healthy federation is silent and every other state is loud.
 *
 * `state` is the parsed `federation/sync-state.json`, or null when the file is
 * missing or unreadable. **Null is a failure, not an unknown** — federation is
 * configured (the caller checked) and no cycle has ever finished writing one.
 *
 * `now` is a parameter rather than a call to `Date.now()` so the staleness
 * boundary can be tested from both sides. Same reason the Rust `render_status`
 * takes one.
 */
// `detail` is the only string in the assembled context that came from off the
// machine: a `HubMsg::Reject` reason, written to sync-state.json by the client.
// The client bounds and strips it at the source now, but this file READS a
// state file that may have been written by an older one, and it is the last
// step before the text reaches a session. So the rule is applied again where
// the value is consumed.
//
// Not a shared constant with the Rust cap: this is a defensive re-bound of
// persisted data of unknown age, not a protocol value the two sides have to
// agree on. It only has to be finite.
const HUB_TEXT_CAP = 500;

function hubText(raw) {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  return clean.length > HUB_TEXT_CAP ? `${clean.slice(0, HUB_TEXT_CAP)}… (truncated)` : clean;
}

export function federationLine(state, now) {
  if (!state) {
    return 'configured, but no sync cycle has ever completed. Run `ll-search status`.';
  }
  if (state.outcome === 'error') {
    return `last sync failed — ${hubText(state.detail) ?? 'no detail recorded'}`;
  }
  // The shape the Rust writes: { kind: "nothing" } | { kind: "index", sha256, note_count }.
  if (state.hub_holds?.kind === 'nothing') {
    return 'the hub holds no index for this vault. The next sync will re-upload it.';
  }
  const at = state.last_success_at;
  if (!at) return 'no sync has ever succeeded on this vault.';
  const age = now - at;
  if (age > STALE_AFTER) {
    return `last successful sync was ${Math.floor(age / 86400)} days ago.`;
  }
  return null;
}

/**
 * Every configured vault profile that has something to say, at most three.
 *
 * The registry is read only when it exists. A single-vault install has no
 * `vaults.json` at all and its config dir is the plugin data root — that is the
 * zero-migration case working, not a fallback rescuing an error.
 */
function federationLines(pluginData, now) {
  const registryPath = FEDERATION_PATHS.vaultRegistry(pluginData);
  let profiles = [{ id: null, config_dir: pluginData }];
  if (existsSync(registryPath)) {
    const { value: doc } = safeLoad(registryPath, { fallback: null });
    if (!Array.isArray(doc?.vaults)) return [];
    profiles = doc.vaults;
  }

  const lines = [];
  for (const profile of profiles) {
    const dir = profile.config_dir;
    if (typeof dir !== 'string' || !existsSync(FEDERATION_PATHS.config(dir))) continue;
    const { value: state } = safeLoad(FEDERATION_PATHS.syncState(dir), { fallback: null });
    const line = federationLine(state, now);
    if (line) lines.push(profile.id ? `${profile.id}: ${line}` : line);
    if (lines.length === 3) break;
  }
  return lines;
}

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

// What the intentions block SHIPPED, read back off the rendered text rather
// than taken from the list that went in. capSection drops whole lines to fit
// MEM_CAP, so the assembled set overstates what the session was shown, and a
// join built on the assembled set would score impressions that never
// happened. The count suffix is stripped from the right so a context whose
// own name contains parentheses survives intact.
export function shippedIntentionContexts(text) {
  if (!text) return [];
  const out = [];
  for (const line of String(text).split('\n')) {
    // One shape, checked once. Guarding on the raw line and matching on the
    // trimmed one meant the trim could never change the outcome, and an
    // indented row would be rejected by the guard before the trim it was
    // there to survive.
    const m = /^- (.+) \(\d+ notes?\)$/.exec(line.trim());
    if (m) out.push(m[1]);
  }
  return out;
}

// Memory index injection. When the index fits under the cap, inject it whole —
// every line carries signal. When it overflows, soft-truncate: keep the head up
// to the last full line under the cap (still real, grep-able entries in raw
// /dream write-order) and tag the cut with a count of how many entries were
// dropped. The Retrieval Protocol already instructs the model to read indexes
// it deems relevant — the pointer tells it where to go for the rest.
function readMemoryIndexCapped(path) {
  const raw = readFileSync(path, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') <= MEM_CAP) return raw.trim();
  const entryCount = (raw.match(/^\s*-\s/gm) || []).length;
  const head = Buffer.from(raw, 'utf8').subarray(0, MEM_CAP).toString('utf8');
  const cut = head.slice(0, head.lastIndexOf('\n'));
  const shown = (cut.match(/^\s*-\s/gm) || []).length;
  return `${cut.trim()}\n… ${entryCount - shown} more entries — read ${path}`;
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
  const searchCmd = 'll-run vault-search.mjs';

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
  // Skip the full protocol when the static section is installed (detected by
  // its version marker) and deps are satisfied: re-injecting it costs ~250
  // duplicated instruction tokens every session start. The compact pointer
  // keeps the one dynamic piece the static section cannot carry (the resolved
  // script path). A broken episodic install still gets the full protocol so
  // the deps-skipped line is surfaced.
  let staticProtocolPresent = false;
  try {
    staticProtocolPresent = readFileSync(join(home(), '.claude', 'CLAUDE.md'), 'utf8').includes(
      '<!-- learning-loop v',
    );
  } catch {
    // No readable CLAUDE.md: inject the full protocol.
  }

  if (staticProtocolPresent && depsAllSatisfied) {
    ctx.context += '\n## Learning Loop — Retrieval Protocol\n';
    ctx.context += `Follow the Learning Loop section in your CLAUDE.md. Vault search: \`${searchCmd} search "<topic>"\`; intentions drill-in: \`${searchCmd} intentions "<context>"\`.\n`;
  } else {
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
  }

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

  // Sections 4-7 and the intention list are read off disk — memory indexes,
  // learned patterns, peer names, note frontmatter. All of it is third-party
  // text that lands in a prompt, so it is gathered here and emitted inside one
  // untrusted-data envelope (the prose sibling of wrapRetrieval's JSON one)
  // rather than concatenated raw next to the plugin's own instructions. The
  // operator lines that used to sit between those sections move to
  // operatorTail so they stay outside the envelope, and the block is emitted
  // where section 4 began — keeping the capped indexes ahead of lower-value
  // sections for emitJson's tail trim.
  let retrieved = '';
  let operatorTail = '';

  // 4. Project-specific auto-memory. Capped memory indexes come right after
  // the protocol so an oversized payload evicts later, lower-value sections
  // instead of the index lines.
  let projectMemoryIndex = null;
  if (projectDir) {
    const encodedPath = encodeProjectDir(projectDir);
    projectMemoryIndex = join(memoryDir, encodedPath, 'memory', 'MEMORY.md');
    if (existsSync(projectMemoryIndex) && memoryIsFresh(projectMemoryIndex)) {
      try {
        const index = readMemoryIndexCapped(projectMemoryIndex);
        if (index) {
          retrieved += `\n## Auto-memory index for this project:\n${index}\n`;
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
  const encodedVaultParent = encodeProjectDir(vaultParent);
  const globalMemory = join(memoryDir, encodedVaultParent, 'memory', 'MEMORY.md');
  if (
    globalMemory !== projectMemoryIndex &&
    existsSync(globalMemory) &&
    memoryIsFresh(globalMemory)
  ) {
    try {
      const globalIndex = readMemoryIndexCapped(globalMemory);
      if (globalIndex) {
        retrieved += `\n## Global memory index:\n${globalIndex}\n`;
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
          retrieved += `\n## Learned Patterns (from verification feedback)\n${patterns}\n`;
        }
      } catch (err) {
        logError('session-start.context-assembly.learnedPatterns', err);
      }
    }

    // 7. Federation status — a line only when there is something wrong.
    try {
      const lines = federationLines(pluginData, Math.floor(Date.now() / 1000));
      if (lines.length > 0) {
        retrieved += `\n## Federation\n${lines.join('\n')}\n`;
      }
    } catch (err) {
      logError('session-start.context-assembly.federation', err);
    }
  }

  // 8. On-demand vault captures pointer.
  operatorTail += '\n## Recent vault captures\n';
  operatorTail += `Run \`ls -t ${VAULT_INBOX} | head -5\` or \`${searchCmd} search "<topic>"\` for relevant notes.\n`;

  // 9. Intention summary — read cached marker; refresh in background. The
  // rendered list is capped: the marker array is unbounded (one line per
  // intention context), and an oversized list must not evict earlier sections.
  // pluginData required: the worker resolves PLUGIN_DATA from the same source
  // (config.mjs reads CLAUDE_PLUGIN_DATA). A fallback to pluginDir would
  // produce a different path than the worker writes to.
  if (pluginData) {
    try {
      const cached = readMarker(MARKER_PATHS.intentions(pluginData));
      // One marker entry per distinct `context` string, and most group a single
      // note: cue-shaped sentences get written into the context slot, so each
      // produces its own one-note "context". Rendering them all overruns
      // MEMORY_INDEX_MAX_BYTES, so the list is cut mid-way and ships an
      // arbitrary prefix while dropping the contexts that group real work.
      const grouped = Array.isArray(cached) ? cached.filter((item) => item.count > 1) : [];
      if (grouped.length > 0) {
        let list = '';
        for (const item of grouped) {
          list += `- ${item.context} (${item.count} notes)\n`;
        }
        const capped = capSection(
          list,
          `[truncated — run \`${searchCmd} intentions\` for the full list]`,
        );
        retrieved += '\n## Notes with active intentions:\n';
        retrieved += `${capped}\n`;
        operatorTail += `\nTo see notes for a specific context: ${searchCmd} intentions "<context name>"\n`;
        // The pack has never had a surfaced->used join, so the value of this
        // block is unmeasured rather than low. Record what shipped, read back
        // off the capped text: assembled_count alongside it is what the cap
        // dropped, which is the block's other open question.
        writeRetrieval({
          pluginData,
          prefix: 'session-start-pack',
          command: 'intentions',
          query: '',
          results: null,
          meta: {
            contexts: shippedIntentionContexts(capped),
            assembled_count: grouped.length,
          },
        });
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

  const framed = wrapRetrievalText(retrieved, { origin: 'session-start' });
  if (framed) ctx.context += `\n${framed}\n`;
  ctx.context += operatorTail;

  // 10. Emit session-start provenance event inline: one JSONL append is
  // cheaper than a detached node child (see modules/provenance.mjs, which
  // made the same call for the post-tool hot path).
  try {
    emitProvenance({ agent: 'session', action: 'session-start' });
  } catch (err) {
    logError('session-start.context-assembly.provenance', err);
  }
}
