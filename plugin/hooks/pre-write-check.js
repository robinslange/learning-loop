#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import {
  runHook,
  resolvePluginData,
  resolveVaultPath,
  findBinary as findBinaryShared,
  isVaultNote,
} from './lib/common.mjs';
import { loadVaultSnapshot } from './lib/snapshot.mjs';
import { parseFrontmatter, parseTags, extractWikilinks } from '../scripts/lib/markdown-parse.mjs';
import { HookConfig } from '../scripts/lib/hook-config.mjs';
import { spawnEnv } from '../scripts/lib/env.mjs';
import { logError } from '../scripts/lib/log.mjs';
import { appendJsonlLineSafe } from '../scripts/lib/jsonl.mjs';
import { DATA_FILES } from '../scripts/lib/paths.mjs';
import { emitJson } from './lib/io.mjs';

// Distinguishable error code for a duplicate-gate timeout (socket or
// subprocess). /doctor's duplicate-gate-health check scans the monthly
// hook-errors log for repeats of this code to detect a permanently-disabled
// gate (the silent-pass-on-timeout failure mode).
export const DUPLICATE_GATE_TIMEOUT_CODE = 'duplicate-gate-timeout';

function logDuplicateGateTimeout(pluginData, source, detail) {
  if (!pluginData) return;
  const month = new Date().toISOString().slice(0, 7);
  appendJsonlLineSafe(join(pluginData, `hook-errors-${month}.jsonl`), {
    ts: new Date().toISOString(),
    module: 'pre-write-check.checkDuplicateNote',
    code: DUPLICATE_GATE_TIMEOUT_CODE,
    source,
    message: String(detail).slice(0, HookConfig.ERROR_MSG_MAX_CHARS),
  });
}

// Try the long-running ll-search watch daemon's UDS socket for the duplicate
// scan. Mirrors edge-infer.mjs's runNliBatchViaDaemon: tight connect timeout so
// an absent daemon costs nothing, a bounded response timeout, and a structured
// {ok, ...} result the caller dispatches on. The model stays warm in the
// daemon, so this avoids the ~800ms-2s ONNX cold start the subprocess pays.
function reflectScanViaDaemon(socketPath, queries, top, candidates) {
  return new Promise((resolveResult) => {
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
      resolveResult(value);
    };

    const socket = createConnection({ path: socketPath });
    let buffer = '';

    const timer = setTimeout(() => {
      settle({ ok: false, reason: 'timeout' });
    }, HookConfig.QUERY_TIMEOUT_MS);

    socket.setTimeout(50, () => {
      if (!buffer && !socket.connecting) {
        settle({ ok: false, reason: 'idle-timeout' });
      }
    });

    socket.on('connect', () => {
      socket.setTimeout(0);
      const request = JSON.stringify({ kind: 'duplicate-scan', queries, top, candidates }) + '\n';
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
        const reason = buffer.length === 0 ? 'closed-before-response' : 'daemon-closed-mid-stream';
        settle({ ok: false, reason });
      }
    });
  });
}

function findDuplicateTags(tags) {
  const seen = new Set();
  const dupes = new Set();
  for (const t of tags) {
    if (seen.has(t)) dupes.add(t);
    seen.add(t);
  }
  return [...dupes];
}

const DASH_RE = /[—–]/;

// Em/en-dashes are a voice violation in body prose (persona.md: "No em dashes,
// no en dashes."). They are legitimate structural annotation on Source:/Related:
// lines, which separate a reference from its gloss, so those lines are exempt.
function findEmDashLines(body) {
  const offending = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(Sources?:|Related:)/.test(line.trimStart())) continue;
    if (DASH_RE.test(line)) {
      offending.push({ line: i + 1, text: line.trim() });
    }
  }
  return offending;
}

// Count em/en-dashes on non-exempt lines (same Source:/Related: exemption as
// findEmDashLines). Used to detect dashes ADDED by an Edit: a dash that exists
// in both old_string and new_string is pre-existing and must not deny.
function countExposedDashes(text) {
  let count = 0;
  for (const line of text.split('\n')) {
    if (/^(Sources?:|Related:)/.test(line.trimStart())) continue;
    const matches = line.match(/[—–]/g);
    if (matches) count += matches.length;
  }
  return count;
}

function buildNoteIndex(vaultRoot) {
  const snap = loadVaultSnapshot(vaultRoot);
  const notes = snap?.notes ?? [];
  const basenames = new Set();
  const relPaths = new Set();
  for (const n of notes) {
    basenames.add(`${n.basename}.md`);
    if (n.rel_path) {
      relPaths.add(n.rel_path);
      relPaths.add(n.rel_path.replace(/\.md$/, ''));
    }
  }
  return { basenames, relPaths };
}

function noteExistsInIndex(name, noteIndex) {
  if (noteIndex.basenames.has(`${name}.md`)) return true;
  if (noteIndex.relPaths.has(name)) return true;
  if (noteIndex.relPaths.has(`${name}.md`)) return true;
  return false;
}

// Interpret a reflect-scan result envelope (same shape from the daemon and the
// subprocess) into a warning string, or null when there's no above-threshold
// non-self duplicate.
function interpretScanResult(result, filePath, vaultRoot) {
  const q = result.queries && result.queries[0];
  if (!q || !q.top_match_similarity || q.top_match_similarity < HookConfig.SIMILARITY_THRESHOLD)
    return null;
  const topResult = q.results && q.results[0];
  if (!topResult) return null;

  const topAbsolute = resolve(join(vaultRoot, topResult.path));
  if (topAbsolute === resolve(filePath)) return null;

  const pct = Math.round(q.top_match_similarity * 100);
  return `Potential duplicate: "${topResult.title || topResult.path}" at ${topResult.path} (${pct}% similar).`;
}

async function checkDuplicateNote(filePath, title, vaultRoot) {
  const pluginData = resolvePluginData();
  const dbPath = join(vaultRoot, '.vault-search', 'vault-index.db');
  if (!existsSync(dbPath)) return null;

  // Daemon path: the warm watch process serves the same reflect scan over its
  // UDS socket. Try it first; fall through to the subprocess when the socket is
  // absent (no daemon) or errors. Windows has no socket and always falls back.
  const socketPath = pluginData ? DATA_FILES.nliSocket(pluginData) : null;
  if (socketPath && existsSync(socketPath)) {
    const daemonResult = await reflectScanViaDaemon(socketPath, [title], 1, 5);
    if (daemonResult.ok) {
      if (daemonResult.parsed && daemonResult.parsed.error) {
        logError(
          'pre-write-check.checkDuplicateNote.daemon',
          new Error(String(daemonResult.parsed.error)),
        );
      } else {
        return interpretScanResult(daemonResult.parsed, filePath, vaultRoot);
      }
    } else if (daemonResult.reason === 'timeout' || daemonResult.reason === 'idle-timeout') {
      // The gate timed out against the warm daemon — log it distinctly so
      // /doctor can flag a permanently-disabled gate, then fall through to the
      // subprocess as a slow-path safety net.
      logDuplicateGateTimeout(pluginData, 'daemon', daemonResult.reason);
    } else if (
      daemonResult.reason !== 'socket-error' &&
      daemonResult.reason !== 'closed-before-response'
    ) {
      logError(
        `pre-write-check.checkDuplicateNote.daemon.${daemonResult.reason}`,
        daemonResult.err || new Error(daemonResult.reason),
      );
    }
  }

  // Subprocess fallback: a fresh ll-search that cold-starts the model.
  try {
    const binary = findBinaryShared();
    if (!binary) return null;

    const out = execFileSync(
      binary.bin,
      ['reflect-scan', dbPath, title, '--top', '1', '--candidates', '5'],
      {
        encoding: 'utf-8',
        timeout: HookConfig.QUERY_TIMEOUT_MS,
        env: spawnEnv({ ORT_DYLIB_PATH: binary.binDir, ORT_LIB_LOCATION: binary.binDir }),
      },
    );
    return interpretScanResult(JSON.parse(out), filePath, vaultRoot);
  } catch (err) {
    // ETIMEDOUT / SIGTERM from execFileSync's timeout is the silent-disable
    // failure mode — log it distinctly too, on top of the generic error log.
    if (err && (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM')) {
      logDuplicateGateTimeout(pluginData, 'subprocess', err.code || err.signal);
    }
    logError('pre-write-check.checkDuplicateNote', err);
    return null;
  }
}

function deny(reason) {
  emitJson({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

function warn(context) {
  emitJson({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: context,
    },
  });
}

runHook(async ({ tool, input }) => {
  if (tool !== 'Write' && tool !== 'Edit') return;

  const filePath = input.file_path;
  if (!filePath) return;

  const vaultRoot = resolveVaultPath();
  if (!isVaultNote(filePath, vaultRoot)) return;

  // Edit payloads carry string fragments, not whole notes: recompute the
  // post-edit note from disk so the dash delta runs on the SAME body-only
  // semantics as the Write path (frontmatter excluded, Source:/Related: line
  // prefixes visible even when the fragment omits them). Warn on broken
  // wikilinks in the replacement text, and skip the duplicate-tag/
  // duplicate-note checks (a fragment has no reliable title to judge).
  if (tool === 'Edit') {
    const oldString = input.old_string || '';
    const newString = input.new_string || '';

    // Fallback when the file is unreadable: judge the raw fragments.
    let oldText = oldString;
    let newText = newString;
    let skipDashCheck = false;
    if (oldString) {
      let disk = null;
      try {
        disk = readFileSync(filePath, 'utf-8');
      } catch {
        disk = null;
      }
      if (disk !== null) {
        const idx = disk.indexOf(oldString);
        if (idx === -1) {
          // old_string not on disk: the Edit tool itself errors — nothing to gate.
          skipDashCheck = true;
        } else {
          const postEdit = input.replace_all
            ? disk.split(oldString).join(newString)
            : disk.slice(0, idx) + newString + disk.slice(idx + oldString.length);
          oldText = parseFrontmatter(disk).body;
          newText = parseFrontmatter(postEdit).body;
        }
      }
    }

    if (!skipDashCheck && countExposedDashes(newText) > countExposedDashes(oldText)) {
      const offending = findEmDashLines(newString);
      const lines = offending.length > 0 ? offending : findEmDashLines(newText);
      const list = lines.map((l) => `  ${l.text}`).join('\n');
      deny(
        `This edit adds em/en-dashes to body prose (persona voice rule "no em dashes, no en dashes"):\n${list}\n` +
          `Replace each with a comma, colon, or semicolon. If the dash is structural ` +
          `annotation (reference + gloss), move it to a Source: or Related: line, which are exempt.`,
      );
      return;
    }

    const noteIndex = buildNoteIndex(vaultRoot);
    const broken = extractWikilinks(newString).filter((l) => {
      const target = l.split('#')[0].trim();
      return target && !noteExistsInIndex(target, noteIndex);
    });
    if (broken.length > 0) {
      warn(
        `Broken wikilinks: ${broken.map((l) => '[[' + l + ']]').join(', ')} not found in vault.`,
      );
    }
    return;
  }

  const content = input.content || '';
  const { fm, body: fmBody } = parseFrontmatter(content);
  if (Object.keys(fm).length > 0) {
    const tags = parseTags(fm);
    const dupes = findDuplicateTags(tags);
    if (dupes.length > 0) {
      deny(`Duplicate tags found: [${dupes.join(', ')}]. Remove duplicates before writing.`);
      return;
    }
  }

  // Same added-only delta rule as the Edit path: a Write that rewrites an
  // existing note (reflect refinement applies upstream edits via Write) must
  // not be denied for dashes the note already carries on disk. New files keep
  // the any-dash deny.
  const emDashLines = findEmDashLines(fmBody);
  if (emDashLines.length > 0) {
    let dashAdded = true;
    if (existsSync(filePath)) {
      const { body: onDiskBody } = parseFrontmatter(readFileSync(filePath, 'utf-8'));
      dashAdded = countExposedDashes(fmBody) > countExposedDashes(onDiskBody);
    }
    if (dashAdded) {
      const list = emDashLines.map((l) => `  line ${l.line}: ${l.text}`).join('\n');
      deny(
        `Em/en-dashes in body prose (persona voice rule "no em dashes, no en dashes"):\n${list}\n` +
          `Replace each with a comma, colon, or semicolon. If the dash is structural ` +
          `annotation (reference + gloss), move it to a Source: or Related: line, which are exempt.`,
      );
      return;
    }
  }

  const warnings = [];

  const links = extractWikilinks(fmBody);
  const noteIndex = buildNoteIndex(vaultRoot);
  const broken = links.filter((l) => {
    const target = l.split('#')[0].trim();
    return target && !noteExistsInIndex(target, noteIndex);
  });
  if (broken.length > 0) {
    warnings.push(
      `Broken wikilinks: ${broken.map((l) => '[[' + l + ']]').join(', ')} not found in vault.`,
    );
  }

  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : null;
  const dupeWarning = title ? await checkDuplicateNote(filePath, title, vaultRoot) : null;
  if (dupeWarning) {
    warnings.push(dupeWarning);
  }

  if (warnings.length > 0) {
    warn(warnings.join('\n'));
  }
});
