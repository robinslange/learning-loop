// hooks/modules/edge-infer.mjs : Wikilink → edge classification.
// Extracted from the pre-coalescing standalone edge-infer hook. Snapshot-backed
// vault index (no per-call recursive readdir).

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { resolvePluginData, isVaultNote, findBinary } from '../lib/common.mjs';
import { buildVaultIndexFromSnapshot } from '../lib/snapshot.mjs';
import { logError } from '../../scripts/lib/log.mjs';
import {
  openEdgeDb,
  addEdge,
  removeOutgoingEdges,
  removeOutgoingNliEdges,
  saveDb,
  acquireLock,
  releaseLock,
} from '../../scripts/lib/edges.mjs';
import { classifyNoteEdges, makeResolver } from '../../scripts/lib/edge-classifier.mjs';
import { spawnEnv } from '../../scripts/lib/env.mjs';
import { DATA_FILES } from '../../scripts/lib/paths.mjs';

const EDGE_TYPE_TO_FRONTMATTER_KEY = {
  evidence_for: 'evidence-for',
  supports: 'supports',
  derived_from: 'derived-from',
  challenges_undermining: 'undermines',
  challenges_undercutting: 'undercuts',
  challenges_rebuttal: 'rebuts',
};

function parseThresholdEnv(varName, defaultValue) {
  const raw = process.env[varName];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    // Don't go through logError — this is a module-load-time invariant
    // failure, not a per-call runtime error. Print once to stderr so users
    // tuning env vars actually see the warning.
    process.stderr.write(
      `learning-loop: ${varName}=${JSON.stringify(raw)} is not a finite number in [0, 1]; falling back to ${defaultValue}\n`,
    );
    return defaultValue;
  }
  return parsed;
}

const NLI_CONTRADICTION_THRESHOLD = parseThresholdEnv('LL_NLI_THRESHOLD', 0.9);
const NLI_ENTAILMENT_THRESHOLD = parseThresholdEnv('LL_NLI_ENTAIL_THRESHOLD', 0.75);
// Bundle 2 promotion-gate thresholds. HARD is the surface-and-confirm cutoff
// in inbox-organiser (matches the existing frontmatter-sync default at
// edges.mjs:222). TENSION is the advisory-flag floor (matches the entailment
// threshold for symmetry, deliberately UNVALIDATED for contradiction precision
// in this range; see OUTCOME.md). Both used by getNliEdgesForNote consumers.
export const NLI_HARD_THRESHOLD = parseThresholdEnv('LL_NLI_HARD_THRESHOLD', 0.95);
export const NLI_TENSION_THRESHOLD = parseThresholdEnv('LL_NLI_TENSION_THRESHOLD', 0.75);
// Ordering invariant: TENSION <= contradiction-write <= HARD. A misconfigured
// env would silently break the surface tiers; fail loudly at load.
if (
  !(
    NLI_TENSION_THRESHOLD <= NLI_CONTRADICTION_THRESHOLD &&
    NLI_CONTRADICTION_THRESHOLD <= NLI_HARD_THRESHOLD
  )
) {
  throw new Error(
    `learning-loop: NLI threshold ordering violated. Expected ` +
      `LL_NLI_TENSION_THRESHOLD (${NLI_TENSION_THRESHOLD}) <= ` +
      `LL_NLI_THRESHOLD (${NLI_CONTRADICTION_THRESHOLD}) <= ` +
      `LL_NLI_HARD_THRESHOLD (${NLI_HARD_THRESHOLD}).`,
  );
}
const NLI_SCHEMA_VERSION = 1;

// Strip markdown that the NLI tokenizer wasn't trained on: wikilinks, tags,
// headers, emphasis, code fences. Keeps inner text of wikilinks so claims
// like "[[sleep]] enhances memory" become "sleep enhances memory" — the model
// scores prose, not link syntax.
export function stripMarkdownForNli(text) {
  if (!text) return '';
  return (
    text
      // Code fences + inline code FIRST so subsequent link/emphasis regexes
      // don't mangle text inside backticks (e.g. `[text](url)` should keep
      // its contents as opaque code, not be parsed as a markdown link).
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      // Wikilinks: [[Target|Display]] -> Display, [[Target]] -> Target
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      // Markdown links: [text](url) -> text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // ATX headers and setext underlines
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^[=-]{2,}\s*$/gm, '')
      // Bold / italic / strikethrough
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1')
      .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      // Hashtags
      .replace(/(^|\s)#[\w/-]+/g, '$1')
      // List markers at line start
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      // Blockquote markers
      .replace(/^>\s?/gm, '')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function vaultRelPath(filePath, vaultRoot) {
  return filePath.slice(vaultRoot.length + 1);
}

function parseInlineArray(value) {
  const m = value.match(/^\[(.*)\]$/);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function formatInlineArray(items) {
  return '[' + items.map((s) => `"${s}"`).join(', ') + ']';
}

function parseBlockArray(lines, startIdx) {
  const items = [];
  let i = startIdx + 1;
  while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
    const item = lines[i]
      .replace(/^\s*-\s+/, '')
      .replace(/^["']|["']$/g, '')
      .trim();
    if (item) items.push(item);
    i++;
  }
  return { items, endIdx: i - 1 };
}

function syncFrontmatterEdges(filePath, highConfidenceEdges) {
  if (highConfidenceEdges.length === 0) return false;

  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return false;
  }

  const grouped = {};
  for (const edge of highConfidenceEdges) {
    const key = EDGE_TYPE_TO_FRONTMATTER_KEY[edge.edgeType];
    if (!key) continue;
    if (!grouped[key]) grouped[key] = new Set();
    const bare = basename(edge.toPath, '.md');
    grouped[key].add(`[[${bare}]]`);
  }

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---(\n?)/);

  if (!fmMatch) {
    const newKeys = Object.entries(grouped)
      .map(([k, links]) => `${k}: ${formatInlineArray([...links])}`)
      .join('\n');
    const newContent = `---\n${newKeys}\n---\n${content}`;
    writeFileSync(filePath, newContent);
    return true;
  }

  const fmBody = fmMatch[1];
  const trailingNewline = fmMatch[2];
  const afterFm = content.slice(fmMatch[0].length);

  let lines = fmBody.split('\n');
  let changed = false;

  for (const [key, links] of Object.entries(grouped)) {
    const lineIdx = lines.findIndex((l) => new RegExp(`^${key}:\\s*`).test(l));
    if (lineIdx === -1) {
      lines.push(`${key}: ${formatInlineArray([...links])}`);
      changed = true;
      continue;
    }

    const valueAfterColon = lines[lineIdx].slice(key.length + 1).trim();

    if (valueAfterColon === '') {
      const block = parseBlockArray(lines, lineIdx);
      const merged = new Set(block.items);
      let added = false;
      for (const link of links) {
        if (!merged.has(link)) {
          merged.add(link);
          added = true;
        }
      }
      if (added) {
        lines.splice(
          lineIdx,
          block.endIdx - lineIdx + 1,
          `${key}: ${formatInlineArray([...merged])}`,
        );
        changed = true;
      }
      continue;
    }

    const existingArray = parseInlineArray(valueAfterColon);
    if (existingArray === null) continue;
    const merged = new Set(existingArray);
    let added = false;
    for (const link of links) {
      if (!merged.has(link)) {
        merged.add(link);
        added = true;
      }
    }
    if (added) {
      lines[lineIdx] = `${key}: ${formatInlineArray([...merged])}`;
      changed = true;
    }
  }

  if (!changed) return false;

  const newContent = '---\n' + lines.join('\n') + '\n---' + trailingNewline + afterFm;
  writeFileSync(filePath, newContent);
  return true;
}

function validateNliEnvelope(parsed, label) {
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    parsed.schema_version !== NLI_SCHEMA_VERSION ||
    !Array.isArray(parsed.results)
  ) {
    logError(
      `edge-infer.runNliBatch.schemaMismatch.${label}`,
      new Error(
        `NLI ${label} schema mismatch — expected {schema_version: ${NLI_SCHEMA_VERSION}, results: [...]}, got ${JSON.stringify(parsed).slice(0, 200)}`,
      ),
    );
    return null;
  }
  return parsed.results;
}

// Try the long-running ll-search watch daemon via Unix socket. Returns null
// quickly if the socket isn't there or isn't ready — caller falls back to
// subprocess. Connect timeout deliberately tight (50ms) so absent-daemon
// detection doesn't add user-visible latency.
function runNliBatchViaDaemon(socketPath, premise, hypotheses) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.end();
      } catch {
        /* ignore */
      }
      clearTimeout(timer);
      resolve(value);
    };

    const socket = createConnection({ path: socketPath });
    let buffer = '';

    const timer = setTimeout(() => {
      settle({ ok: false, reason: 'timeout' });
    }, 5000);

    socket.setTimeout(50, () => {
      // 50ms initial connect/no-data timeout. Once data starts flowing the
      // 5000ms outer timer governs.
      if (!buffer && !socket.connecting) {
        settle({ ok: false, reason: 'idle-timeout' });
      }
    });

    socket.on('connect', () => {
      socket.setTimeout(0); // clear the initial connect timeout
      const request = JSON.stringify({ premise, hypotheses }) + '\n';
      socket.write(request);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        const line = buffer.slice(0, nl);
        try {
          settle({ ok: true, parsed: JSON.parse(line) });
        } catch (err) {
          settle({ ok: false, reason: 'parse-error', err });
        }
      }
    });

    socket.on('error', (err) => {
      settle({ ok: false, reason: 'socket-error', err });
    });

    socket.on('close', () => {
      if (!settled) {
        // Distinguish a connection that closed without ever seeing bytes
        // (normal "no daemon" fallthrough) from one that closed mid-stream
        // with partial bytes (genuine daemon misbehaviour we want to surface).
        const reason = buffer.length === 0 ? 'closed-before-response' : 'daemon-closed-mid-stream';
        settle({ ok: false, reason });
      }
    });
  });
}

function runNliBatchViaSubprocess(binary, premise, hypotheses) {
  let tempDir;
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'nli-'));
    const hypsPath = join(tempDir, 'hyps.txt');
    writeFileSync(hypsPath, hypotheses.join('\n'));

    const out = execFileSync(binary.bin, ['nli-batch', premise, hypsPath], {
      encoding: 'utf-8',
      // Production default 1500ms. Tests that exercise the real fork override
      // this via LL_NLI_SUBPROCESS_TIMEOUT_MS: under a saturating parallel
      // suite the stub spawn can exceed 1500ms and flake (the timing path the
      // override does not let them bypass — they're testing the fork itself).
      timeout: Number(process.env.LL_NLI_SUBPROCESS_TIMEOUT_MS) || 1500,
      env: spawnEnv({ ORT_DYLIB_PATH: binary.binDir, ORT_LIB_LOCATION: binary.binDir }),
    });

    const parsed = JSON.parse(out);
    const results = validateNliEnvelope(parsed, 'subprocess');
    return results || [];
  } catch (err) {
    logError('edge-infer.runNliBatch.subprocess', err);
    return [];
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

// Module-level latches so repeated daemon failures don't spam the log on
// every hook fire. The first failure of each kind logs; subsequent failures
// of the same kind are silent until the process restarts (typically when a
// new Claude Code session boots).
let daemonSchemaMismatchWarned = false;
let daemonHardFailureWarned = false;

// Test-only injection: lets the test suite skip the daemon/subprocess plumbing
// (which forks an ll-search stub under a 1500ms execFileSync timeout — fragile
// under parallel test load). Production paths never see this; tests that
// inject restore null in their teardown.
let _nliBatchOverride = null;

export function __setNliBatchOverrideForTesting(fn) {
  _nliBatchOverride = fn;
}

async function runNliBatch(sourceText, neighbours) {
  if (!neighbours || neighbours.length === 0) return [];

  if (_nliBatchOverride) return _nliBatchOverride(sourceText, neighbours);

  const premise = stripMarkdownForNli(sourceText);
  // Filenames don't contain markdown — basename-to-slug is sufficient.
  const hypotheses = neighbours.map((n) => basename(n.path, '.md').replace(/-/g, ' '));

  // Daemon path: try the UDS socket the long-running ll-search watch process
  // owns. Skips entirely if the socket file is absent (no daemon running) so
  // the fast-path adds zero overhead in that case.
  const pluginData = resolvePluginData();
  if (pluginData) {
    const socketPath = DATA_FILES.nliSocket(pluginData);
    if (existsSync(socketPath)) {
      const daemonResult = await runNliBatchViaDaemon(socketPath, premise, hypotheses);
      if (daemonResult.ok) {
        const results = validateNliEnvelope(daemonResult.parsed, 'daemon');
        if (results) return results;
        // Schema mismatch: the daemon is out of sync with the hook (old daemon
        // vs new hook code, or vice versa). Falling back to subprocess on every
        // hook fire would reload the 233MB model and add ~400ms per write —
        // worse than no NLI at all. Skip NLI for this write and warn ONCE per
        // process so the user knows to restart `ll-search watch`. The schema
        // mismatch is already logged inside validateNliEnvelope.
        if (!daemonSchemaMismatchWarned) {
          daemonSchemaMismatchWarned = true;
          process.stderr.write(
            'learning-loop: NLI daemon returned mismatched schema envelope — restart `ll-search watch` to pick up the new hook contract. NLI edges suppressed for this session.\n',
          );
        }
        return [];
      } else if (
        daemonResult.reason !== 'socket-error' &&
        daemonResult.reason !== 'closed-before-response'
      ) {
        // Real daemon failure modes (timeout, parse-error, idle-timeout). Log
        // once per process to avoid alarm fatigue, but still let the call
        // fall through to subprocess as a slow-path safety net.
        if (!daemonHardFailureWarned) {
          daemonHardFailureWarned = true;
          logError(
            `edge-infer.runNliBatch.daemon.${daemonResult.reason}`,
            daemonResult.err || new Error(daemonResult.reason),
          );
        }
      }
    }
  }

  // Fallback: spawn a fresh subprocess (loads the 233MB model every time).
  const binary = findBinary();
  if (!binary) return [];
  return runNliBatchViaSubprocess(binary, premise, hypotheses);
}

export async function runEdgeInfer(ctx) {
  const { tool, input, response, vaultRoot, snapshot } = ctx;
  if (tool !== 'Write' && tool !== 'Edit') return;
  if (!response || (typeof response === 'object' && response.success === false)) return;
  if (!vaultRoot) return;

  const filePath = input.file_path;
  if (!filePath) return;
  if (!isVaultNote(filePath, vaultRoot)) return;
  if (!snapshot) return;

  const pluginData = resolvePluginData();
  if (!pluginData) return;

  const dbPath = DATA_FILES.edgesDb(pluginData);

  let noteContent;
  if (tool === 'Write') {
    noteContent = input.content || '';
  } else {
    try {
      noteContent = readFileSync(filePath, 'utf-8');
    } catch (err) {
      logError('edge-infer.readContent', err);
      return;
    }
  }

  const sourceName = basename(filePath, '.md');
  const sourceRel = vaultRelPath(filePath, vaultRoot);

  // Regex classifier: only meaningful if note has wikilinks
  let classified = [];
  if (noteContent.includes('[[')) {
    const resolver = makeResolver(buildVaultIndexFromSnapshot(snapshot));
    classified = classifyNoteEdges(noteContent, sourceName, resolver);
  }

  const edges = classified.map((e) => ({
    fromPath: sourceRel,
    toPath: e.toPath,
    edgeType: e.edgeType,
    confidence: e.confidence,
    flip: e.flip,
  }));

  const nliCandidates = ctx.autolinkCandidates || [];

  // Skip work only if BOTH regex and NLI have nothing to do.
  if (edges.length === 0 && nliCandidates.length === 0) return;

  // Extract NLI premise: first non-empty line of body, single-line, max 300 chars.
  let sourceText = sourceName.replace(/-/g, ' ');
  if (nliCandidates.length > 0) {
    const fmStripped = noteContent.replace(/^---\n[\s\S]*?\n---\n?/, '');
    const firstLine = fmStripped
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (firstLine) sourceText = firstLine.slice(0, 300);
  }

  if (!acquireLock(dbPath)) {
    logError(
      'edge-infer.acquireLock',
      new Error(`failed to acquire ${dbPath} after retries; edge work for ${sourceRel} skipped`),
    );
    return;
  }
  const db = await openEdgeDb(dbPath);
  try {
    if (edges.length > 0) {
      removeOutgoingEdges(db, sourceRel);
      for (const edge of edges) {
        addEdge(db, {
          fromPath: edge.fromPath,
          toPath: edge.toPath,
          edgeType: edge.edgeType,
          confidence: edge.confidence,
          directionFlipped: edge.flip ? 1 : 0,
        });
      }
    } else if (nliCandidates.length > 0) {
      // NLI-only path: don't wipe regex-classified edges (preserves frontmatter
      // consistency when wikilinks were removed). Clear only prior NLI edges
      // so the new NLI loop re-derives cleanly.
      removeOutgoingNliEdges(db, sourceRel);
    }

    if (nliCandidates.length > 0) {
      const nliResults = await runNliBatch(sourceText, nliCandidates);
      for (let i = 0; i < nliResults.length; i++) {
        const r = nliResults[i];
        if (!r || r.error) continue;
        if (typeof r.contradiction !== 'number' || typeof r.entailment !== 'number') continue;
        const neighbourRel = nliCandidates[i].path;

        // Contradiction edge: only above NLI_CONTRADICTION_THRESHOLD. Skip if regex
        // already emitted a challenges_* edge to this target — regex wins on
        // conflicts. A regex 'supports' / 'evidence_for' edge does NOT block:
        // a note can both support and rebut the same target (epistemic tension
        // worth surfacing).
        if (r.contradiction > NLI_CONTRADICTION_THRESHOLD) {
          const regexBlocks = edges.some(
            (e) => e.toPath === neighbourRel && e.edgeType.startsWith('challenges_'),
          );
          if (!regexBlocks) {
            try {
              addEdge(db, {
                fromPath: sourceRel,
                toPath: neighbourRel,
                edgeType: 'challenges_rebuttal',
                confidence: 'low',
                sourceGraph: 'nli',
                directionFlipped: 0,
                confidenceScore: r.contradiction,
              });
            } catch (err) {
              logError('edge-infer.nliAddEdge.contradiction', err);
            }
          }
        }

        // Entailment edge: only above NLI_ENTAILMENT_THRESHOLD. Skip if regex
        // already emitted a supports/evidence_for edge to this target — regex
        // wins on support relations too.
        if (r.entailment > NLI_ENTAILMENT_THRESHOLD) {
          const regexBlocks = edges.some(
            (e) =>
              e.toPath === neighbourRel &&
              (e.edgeType === 'supports' || e.edgeType === 'evidence_for'),
          );
          if (!regexBlocks) {
            try {
              addEdge(db, {
                fromPath: sourceRel,
                toPath: neighbourRel,
                edgeType: 'nli_supports',
                confidence: 'low',
                sourceGraph: 'nli',
                directionFlipped: 0,
                confidenceScore: r.entailment,
              });
            } catch (err) {
              logError('edge-infer.nliAddEdge.entailment', err);
            }
          }
        }
      }
    }

    saveDb(db, dbPath);
  } finally {
    db.close();
    releaseLock(dbPath);
  }

  const highConfidenceEdges = edges.filter((e) => e.confidence === 'high' && !e.flip);
  syncFrontmatterEdges(filePath, highConfidenceEdges);
}
