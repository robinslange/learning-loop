// hooks/session-start/context-assembly.mjs : build the additionalContext string.
// Reads update-check cache, memory indices, dream gate, learned patterns,
// and federation status. Mutates ctx.context.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { readMarker, MARKER_PATHS } from '../../scripts/lib/marker-cache.mjs';
import { safeLoad } from '../../scripts/lib/safe-load.mjs';
import { HookConfig } from '../../scripts/lib/hook-config.mjs';
import { logError } from '../../scripts/lib/log.mjs';
import { env } from '../../scripts/lib/env.mjs';
import { DATA_PATHS, FEDERATION_PATHS, home } from '../../scripts/lib/paths.mjs';
import { resolveMemoryDir } from '../../scripts/lib/memory-paths.mjs';
import { spawnDetached, emitProvenance } from '../lib/common.mjs';
import { wrapRetrievalText } from '../../scripts/lib/origin-envelope.mjs';
import { latestLedger } from '../../scripts/lib/session-ledger.mjs';

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

// 0.5. Inject resolved paths for skill consumption.
function injectPaths(ctx) {
  const { pluginDir, pluginData, vaultRoot } = ctx;
  ctx.context += `## Learning Loop Paths\n`;
  ctx.context += `PLUGIN=${pluginDir}\n`;
  ctx.context += `PLUGIN_DATA=${pluginData}\n`;
  ctx.context += `VAULT=${vaultRoot}\n`;
}

// 0.6. Update notification from cached check.
function injectUpdateNotice(ctx) {
  if (!ctx.updateCacheFile) return;
  try {
    const { value: cached } = safeLoad(ctx.updateCacheFile, { fallback: null });
    if (cached?.update_available) {
      ctx.context += `\n## Plugin Update Available\n`;
      ctx.context += `learning-loop ${cached.installed} → ${cached.latest}. Run \`/learning-loop:init\` to update.\n`;
    }
  } catch (err) {
    logError('session-start.context-assembly.updateCache', err);
  }
}

// 1. Detect project from working directory, and surface any missing deps.
function injectProjectAndDeps(ctx) {
  if (ctx.projectDir) {
    ctx.context += `Current project: ${basename(ctx.projectDir)}\n`;
  }
  if (ctx.depsMissing) {
    ctx.context += ctx.depsMissing;
  }
}

// 2. Retrieval protocol. Emitted BEFORE the variable-size sections (memory
// indexes, learned patterns): emitJson trims oversized
// additionalContext from the TAIL, so behavior-defining instructions must
// sit ahead of the bulk that could push the payload past the stdout cap.
// Every variable-size section below is byte-capped via capSection, and the
// memory indexes are assembled first among them so a backstop trim evicts
// the lower-value tail (patterns) before the index lines.
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
function injectRetrievalProtocol(ctx, searchCmd) {
  const { depsAllSatisfied } = ctx;
  let staticProtocolPresent = false;
  try {
    staticProtocolPresent = readFileSync(join(home(), '.claude', 'CLAUDE.md'), 'utf8').includes(
      '<!-- learning-loop v',
    );
    // eslint-disable-next-line learning-loop/no-empty-catch -- no readable CLAUDE.md: staticProtocolPresent stays false, injecting the full protocol.
  } catch {}

  if (staticProtocolPresent && depsAllSatisfied) {
    ctx.context += '\n## Learning Loop — Retrieval Protocol\n';
    ctx.context += `Follow the Learning Loop section in your CLAUDE.md. Vault search: \`${searchCmd} search "<topic>"\`.\n`;
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
    ctx.context +=
      "4. Surface relevant findings in a single line prefixed with 'Recall:' or 'Transfer:'\n";
    ctx.context += '5. When corrected, immediately save to auto-memory as feedback. No delay.\n';
    ctx.context +=
      '6. After substantial work, suggest /learning-loop:reflect to consolidate learnings.\n';
    ctx.context += 'Keep retrieval lightweight — one line per insight, not a wall of text.\n';
  }
}

// 3. Dream gate check — read cached marker; refresh in background.
function injectDreamGate(ctx) {
  if (!ctx.pluginData) return;
  try {
    const cached = readMarker(MARKER_PATHS.dreamGate(ctx.pluginData));
    if (cached?.nudge) {
      ctx.context += `\n## Dream Consolidation Due\n${cached.nudge}\n`;
    }
    spawnDetached('session-start.context-assembly.dreamGate', process.execPath, [
      join(import.meta.dirname, '..', 'lib', 'dream-gate.js'),
    ]);
  } catch (err) {
    logError('session-start.context-assembly.dreamGate', err);
  }
}

// 4. Global memory (keyed to vault parent). Claude Code loads the current
// project's MEMORY.md itself, so the only index worth adding is the vault
// parent's, and only when the session runs somewhere else. Capped and placed
// right after the protocol so an oversized payload evicts later, lower-value
// sections instead of the index lines.
function injectGlobalMemory(ctx, state) {
  const vaultParent = resolve(ctx.vaultRoot, '..');
  const globalMemory = join(resolveMemoryDir(vaultParent, ctx.home), 'MEMORY.md');
  const projectMemoryDir = resolveMemoryDir(ctx.projectDir, ctx.home);
  if (
    (projectMemoryDir && globalMemory === join(projectMemoryDir, 'MEMORY.md')) ||
    !existsSync(globalMemory) ||
    !memoryIsFresh(globalMemory)
  ) {
    return;
  }
  try {
    const globalIndex = readMemoryIndexCapped(globalMemory);
    if (globalIndex) {
      state.retrieved += `\n## Global memory index:\n${globalIndex}\n`;
    }
  } catch (err) {
    logError('session-start.context-assembly.globalMemory', err);
  }
}

// 5. Learned patterns — capped like the memory indexes.
function injectLearnedPatterns(ctx, state) {
  if (!ctx.pluginData) return;
  const patternsFile = join(DATA_PATHS.provenance(ctx.pluginData), 'learned-patterns.md');
  if (!existsSync(patternsFile)) return;
  try {
    const patternsContent = readFileSync(patternsFile, 'utf8');
    const patternCount = (patternsContent.match(/^\d+\./gm) || []).length;
    if (patternCount > 0) {
      const patterns = capSection(patternsContent, `[truncated — full file at ${patternsFile}]`);
      state.retrieved += `\n## Learned Patterns (from verification feedback)\n${patterns}\n`;
    }
  } catch (err) {
    logError('session-start.context-assembly.learnedPatterns', err);
  }
}

// 6. Federation status — a line only when there is something wrong.
function injectFederation(ctx, state) {
  if (!ctx.pluginData) return;
  try {
    const lines = federationLines(ctx.pluginData, Math.floor(Date.now() / 1000));
    if (lines.length > 0) {
      state.retrieved += `\n## Federation\n${lines.join('\n')}\n`;
    }
  } catch (err) {
    logError('session-start.context-assembly.federation', err);
  }
}

// 7. Newest session ledger for this repo: the "what did I do here last time"
// answer in one line. Path only; the note itself is one Read away. Reads the
// project the ledger hook already resolved (marker), rather than resolving it
// again here. SessionStart must never spawn git.
function injectLedgerPointer(ctx, state) {
  const { projectDir, pluginData, vaultRoot } = ctx;
  if (!projectDir || !pluginData || !existsSync(join(vaultRoot, '4-projects'))) return;
  try {
    const cached = readMarker(MARKER_PATHS.ledgerProject(pluginData, projectDir), {
      ttlMs: Infinity,
    });
    if (typeof cached?.project === 'string') {
      const ledger = latestLedger(vaultRoot, cached.project);
      if (ledger) {
        state.operatorTail += `\nLast session here: ${ledger.relPath} (${ledger.date}, ${ledger.status})\n`;
      }
    }
  } catch (err) {
    logError('session-start.context-assembly.ledger', err);
  }
}

// 8. Emit session-start provenance event inline: one JSONL append is
// cheaper than a detached node child (see modules/provenance.mjs, which
// made the same call for the post-tool hot path).
function emitSessionStartProvenance() {
  try {
    emitProvenance({ agent: 'session', action: 'session-start' });
  } catch (err) {
    logError('session-start.context-assembly.provenance', err);
  }
}

export async function run(ctx) {
  const searchCmd = 'll-run vault-search.mjs';

  injectPaths(ctx);
  injectUpdateNotice(ctx);
  injectProjectAndDeps(ctx);
  injectRetrievalProtocol(ctx, searchCmd);
  injectDreamGate(ctx);

  // Sections 4-6 are read off disk — memory indexes, learned patterns, peer
  // names. All of it is third-party text that lands in a prompt, so it is
  // gathered here and emitted inside one untrusted-data envelope (the prose
  // sibling of wrapRetrieval's JSON one) rather than concatenated raw next to
  // the plugin's own instructions. The operator lines that used to sit between
  // those sections move to operatorTail so they stay outside the envelope, and
  // the block is emitted where section 4 began — keeping the capped indexes
  // ahead of lower-value sections for emitJson's tail trim.
  const state = { retrieved: '', operatorTail: '' };

  injectGlobalMemory(ctx, state);
  injectLearnedPatterns(ctx, state);
  injectFederation(ctx, state);
  injectLedgerPointer(ctx, state);

  const framed = wrapRetrievalText(state.retrieved, { origin: 'session-start' });
  if (framed) ctx.context += `\n${framed}\n`;
  ctx.context += state.operatorTail;

  emitSessionStartProvenance();
}
