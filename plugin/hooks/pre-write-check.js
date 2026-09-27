#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import {
  runHook,
  findBinary as findBinaryShared,
  isVaultNote,
  vaultRelPath,
  classifyVaultPath,
} from './lib/common.mjs';
import { checkFilenameStyle } from './lib/filename-style.mjs';
import { loadVaultSnapshot } from './lib/snapshot.mjs';
import { parseFrontmatter, parseTags, extractWikilinks } from '../scripts/lib/markdown-parse.mjs';
import {
  SCHEMA_CLASSES,
  checkFrontmatter,
  formatViolations,
} from '../scripts/lib/frontmatter-schema.mjs';
import { HookConfig, preWriteFailMode, librarianEnabled } from '../scripts/lib/hook-config.mjs';
import { getConfig, getPluginData, getVaultPath } from '../scripts/lib/config.mjs';
import { pendingItems, appendItem, newItemId } from '../scripts/librarian/queue.mjs';
import { env, coerceNumber } from '../scripts/lib/env.mjs';
import { ortSpawnEnv } from '../scripts/lib/binary.mjs';
import { logError } from '../scripts/lib/log.mjs';
import { DATA_FILES } from '../scripts/lib/paths.mjs';
import { safeLoad } from '../scripts/lib/safe-load.mjs';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../scripts/lib/is-main.mjs';
import { emitJson } from './lib/io.mjs';
import { normalizeWrites } from './lib/tool-payload.mjs';

// The hook's outer deadline (hooks.json timeout) starts when the process
// does; the duplicate gate budgets its subprocess fallback from what's left.
const HOOK_START_MS = Date.now();

// hooks.json is the ONLY place this deadline is declared, because it is the
// copy that is actually enforced: the harness parses it at session start and
// SIGKILLs this process on it. A second copy in hook-config could only agree
// or drift, and drift is silent in both directions -- an inner budget above
// the outer deadline is inert, one below it throws away time we were given.
// Found by the COMMAND that invokes this hook, not by parsing the matcher.
// Matchers are regexes Claude Code owns, so `Write.*`, `.*`, `Write | Edit` and
// an absent matcher are all legal spellings of "this entry" -- and the previous
// version returned null for every one of them, silently reinstating the 3s
// budget this change exists to raise. The hook knows its own filename, so
// asking that question deletes the guessing instead of improving it.
//
// Array.isArray at both levels rather than optional chaining alone: `?.` covers
// absent but not wrong-typed, so a PreToolUse that was an object THREW here --
// out of a call site (budgetOkForStyle) that is not inside a try, which meant
// emitVerdict() never ran and every warning and deny already computed for that
// write was discarded. A deadline reader must be total.
export function outerDeadlineMs(hooksJson, hookFile = 'pre-write-check.js') {
  const groups = hooksJson?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return null;
  for (const group of groups) {
    const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
    for (const h of hooks) {
      if (typeof h?.command !== 'string' || !h.command.includes(hookFile)) continue;
      const seconds = h.timeout;
      if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
        return seconds * 1000;
      }
    }
  }
  return null;
}

// Used only when hooks.json cannot be read from here. A failsafe, not a
// mirror: the harness read the real value at session start and we cannot see
// what it got, so this may drift from hooks.json without consequence. It
// floors LOW deliberately -- under-running the deadline wastes time we were
// given, over-running it is the SIGKILL that loses every warning computed so far.
const DEADLINE_UNREADABLE_FLOOR_MS = 3000;

// Resolved lazily and once: a write outside the vault returns before the gate
// runs, and must not pay a file read for a budget it never spends.
let _budgetMs = null;
function preWriteBudgetMs() {
  if (_budgetMs !== null) return _budgetMs;
  // The operator override. The plugin's hooks.json is replaced on every
  // update, so a host needing a longer deadline than the shipped one sets this
  // instead of editing a file that will be overwritten. A contended test
  // harness raises it for the same reason.
  const override = coerceNumber(env.LL_PRE_WRITE_BUDGET_MS, 0);
  if (override > 0) return (_budgetMs = override);
  const { value } = safeLoad(fileURLToPath(new URL('./hooks.json', import.meta.url)), {
    fallback: null,
  });
  _budgetMs = outerDeadlineMs(value) ?? DEADLINE_UNREADABLE_FLOOR_MS;
  return _budgetMs;
}

// Distinguishable error code for a duplicate-gate timeout (socket or
// subprocess). /doctor's duplicate-gate-health check scans the monthly
// hook-errors log for repeats of this code to detect a permanently-disabled
// gate (the silent-pass-on-timeout failure mode).
export const DUPLICATE_GATE_TIMEOUT_CODE = 'duplicate-gate-timeout';

// Distinguishable error code for a daemon running an old binary without
// duplicate-scan support (it rejects the request with a parse error). Without
// this, every vault write silently pays daemon round-trip + cold subprocess
// until the daemon is restarted, and /doctor misdiagnoses any resulting
// timeout as "daemon not running".
export const DUPLICATE_GATE_STALE_DAEMON_CODE = 'duplicate-gate-stale-daemon';

// Sentinel returned by checkDuplicateNote when the scan infrastructure failed
// (timeout, binary error, daemon error). Distinct from null ("scan ran cleanly,
// no duplicate above threshold") so the call site can gate on fail-mode without
// conflating a clean no-match with an infrastructure failure.
export const SCAN_FAILED = Symbol('SCAN_FAILED');

function logDuplicateGateIssue(pluginData, code, source, detail, durations = {}) {
  if (!pluginData) return;
  logError(
    'pre-write-check.checkDuplicateNote',
    String(detail).slice(0, HookConfig.ERROR_MSG_MAX_CHARS),
    {
      code,
      source,
      ...durations,
    },
  );
}

// Try the long-running ll-search watch daemon's UDS socket for the duplicate
// scan. Tight connect timeout so an absent daemon costs nothing, a bounded
// response timeout, and a structured {ok, ...} result the caller dispatches on.
// The model stays warm in the daemon, so this avoids the ~800ms-2s ONNX cold
// start the subprocess pays.
function reflectScanViaDaemon(socketPath, queries, top, candidates) {
  const t0 = Date.now();
  return new Promise((resolveResult) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      // destroy(), not end(): a graceful half-close waits on the peer to finish,
      // but a wedged daemon never will — that leaves the handle open and keeps
      // the event loop alive. Hard teardown releases the socket immediately.
      try {
        socket.destroy();
        // eslint-disable-next-line learning-loop/no-empty-catch -- teardown is already unconditional here; a destroy() failure has nothing left to report to.
      } catch {}
      clearTimeout(timer);
      resolveResult({ ...value, latency_ms: Date.now() - t0 });
    };

    const socket = createConnection({ path: socketPath });
    let buffer = '';

    // Short timer: the warm daemon answers in ~430ms, and the subprocess
    // fallback needs the rest of the hook budget. A wedged daemon must not eat
    // the window the fallback would run in.
    const timer = setTimeout(() => {
      settle({ ok: false, reason: 'timeout' });
    }, HookConfig.PRE_WRITE_DAEMON_TIMEOUT_MS);

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

// Deny only on violations a write INTRODUCES, never on ones it inherits.
// 2977 notes predate the contract; a gate that judged absolute state would
// block every legitimate edit to them and get switched off within a day.
// `oldFm` is null when nothing precedes this write (a new note), which inherits
// no excuses. Passing `{}` instead would read as "an existing note whose
// frontmatter is empty" and hand every new note a free pass on all three
// required keys.
function frontmatterDenial(oldFm, newFm, filePath, vaultRoot) {
  const rel = vaultRelPath(filePath, vaultRoot);
  if (!rel || !SCHEMA_CLASSES.has(classifyVaultPath(rel))) return null;

  const inherited = new Set(oldFm ? checkFrontmatter(oldFm).map((v) => v.id) : []);
  const introduced = checkFrontmatter(newFm).filter((v) => !inherited.has(v.id));
  return introduced.length > 0 ? formatViolations(introduced) : null;
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
// findEmDashLines). Used to detect dashes a write ADDS: a dash the note
// already carries is pre-existing and must not deny.
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

export const GATE_FLAG_REASON = 'pre-write gate scan';

// True when a pending duplicate_flag already exists for this target, at any
// age -- the dedupe check for the enqueue side, deliberately not TTL-bounded
// like checkDuplicateFlagQueue's consultation: an unreviewed suggestion does
// not need re-flagging just because it has sat in the queue a while, it needs
// the librarian to look at it.
function hasPendingDuplicateFlag(items, relPath) {
  return items.some((item) => item.task === 'duplicate_flag' && item.target === relPath);
}

// Interpret a reflect-scan result envelope (same shape from the daemon and the
// subprocess) into a warning string, or null when there's no above-threshold
// non-self duplicate. When relPath is known and the librarian is enabled,
// also enqueues the hit as a duplicate_flag so /inbox review sees a pair the
// gate found. checkDuplicateFlagQueue skips these entries (GATE_FLAG_REASON):
// the next write to this path still scans. Uses
// appendItem directly rather than submitDuplicateFlag: that helper also
// loads/saves librarian state.json (a second file) for a counter the gate has
// no use for, and the gate should touch as little as it needs to stay cheap.
// `pending` is the same pendingItems() read checkDuplicateNote already made
// for the queue consultation -- passed down so the gate's one queue read
// covers both the consult and the dedupe-before-enqueue check.
function interpretScanResult(result, filePath, vaultRoot, relPath, pending) {
  const q = result.queries && result.queries[0];
  if (!q || !q.top_match_similarity || q.top_match_similarity < HookConfig.SIMILARITY_THRESHOLD)
    return null;
  const topResult = q.results && q.results[0];
  if (!topResult) return null;

  const topAbsolute = resolve(join(vaultRoot, topResult.path));
  if (topAbsolute === resolve(filePath)) return null;

  if (relPath && librarianEnabled(getConfig()) && !hasPendingDuplicateFlag(pending, relPath)) {
    try {
      appendItem({
        id: newItemId(),
        task: 'duplicate_flag',
        target: relPath,
        duplicate_of: topResult.path,
        similarity: q.top_match_similarity,
        reason: GATE_FLAG_REASON,
        status: 'pending',
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      logError('pre-write-check.interpretScanResult.enqueue', err);
    }
  }

  const pct = Math.round(q.top_match_similarity * 100);
  return `Potential duplicate: "${topResult.title || topResult.path}" at ${topResult.path} (${pct}% similar).`;
}

// Consult the librarian's duplicate_flag queue for a fresh verdict on THIS
// note path before paying for a scan. `items` is the caller's pendingItems()
// read, made once per gate run and shared with interpretScanResult's dedupe
// check. A queue entry older than DUPLICATE_FLAG_TTL_MS is treated as if it
// were absent: the librarian may have lagged the write, and a stale verdict
// about the note's PREVIOUS content is worse than re-deriving. The gate's own
// enqueued hits are not verdicts: they are a raw similarity about content the
// next write may already have changed, so only classifier flags count.
export function checkDuplicateFlagQueue(relPath, items) {
  const now = Date.now();
  for (const item of items) {
    if (item.task !== 'duplicate_flag' || item.target !== relPath) continue;
    if (item.reason === GATE_FLAG_REASON) continue;
    const ageMs = now - new Date(item.created_at).getTime();
    if (!(ageMs >= 0) || ageMs > HookConfig.DUPLICATE_FLAG_TTL_MS) continue;
    const pct = typeof item.similarity === 'number' ? Math.round(item.similarity * 100) : null;
    return (
      `Potential duplicate: "${item.duplicate_of}" queued for librarian review` +
      (pct !== null ? ` (${pct}% similar).` : '.')
    );
  }
  return null;
}

async function checkDuplicateNote(filePath, title, vaultRoot) {
  const pluginData = getPluginData();
  const dbPath = join(vaultRoot, '.vault-search', 'vault-index.db');
  if (!existsSync(dbPath)) return null;

  const relPath = vaultRelPath(filePath, vaultRoot);
  const libEnabled = librarianEnabled(getConfig());
  let pending = [];
  if (libEnabled) {
    try {
      pending = pendingItems();
    } catch (err) {
      logError('pre-write-check.checkDuplicateNote.pendingItems', err);
    }
  }
  if (relPath && libEnabled) {
    const flagged = checkDuplicateFlagQueue(relPath, pending);
    if (flagged) return flagged;
  }

  // Daemon path: the warm watch process serves the same reflect scan over its
  // UDS socket. Try it first; fall through to the subprocess when the socket is
  // absent (no daemon) or errors. Windows has no socket and always falls back.
  const socketPath = pluginData ? DATA_FILES.dupScanSocket(pluginData) : null;
  if (socketPath && existsSync(socketPath)) {
    const daemonResult = await reflectScanViaDaemon(socketPath, [title], 1, 5);
    if (daemonResult.ok) {
      if (daemonResult.parsed && daemonResult.parsed.error) {
        const msg = String(daemonResult.parsed.error);
        // An old daemon binary parses the duplicate-scan request as a failed
        // NLI request and returns "parse request: ..." — log the distinct
        // stale-daemon code so /doctor can advise a daemon restart instead of
        // misreading the per-write cold-start tax as a missing daemon.
        if (msg.startsWith('parse request')) {
          logDuplicateGateIssue(pluginData, DUPLICATE_GATE_STALE_DAEMON_CODE, 'daemon', msg);
        }
        logError('pre-write-check.checkDuplicateNote.daemon', new Error(msg));
      } else {
        return interpretScanResult(daemonResult.parsed, filePath, vaultRoot, relPath, pending);
      }
    } else if (daemonResult.reason === 'timeout' || daemonResult.reason === 'idle-timeout') {
      // The gate timed out against the warm daemon — log it distinctly so
      // /doctor can flag a permanently-disabled gate, then fall through to the
      // subprocess as a slow-path safety net.
      logDuplicateGateIssue(
        pluginData,
        DUPLICATE_GATE_TIMEOUT_CODE,
        'daemon',
        daemonResult.reason,
        {
          latency_ms: daemonResult.latency_ms,
        },
      );
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
  // Budgeted from what's left of the hook's outer deadline — a daemon attempt
  // may already have burned its timer, and an execFileSync that outlives the
  // hooks.json timeout gets the whole hook SIGKILLed (losing the already-
  // computed warnings), which is strictly worse than skipping the scan.
  let subprocessT0;
  try {
    const binary = findBinaryShared();
    if (!binary) return SCAN_FAILED;

    const budgetMs = preWriteBudgetMs();
    const elapsedMs = Date.now() - HOOK_START_MS;
    const remainingMs = budgetMs - elapsedMs - HookConfig.PRE_WRITE_SAFETY_MARGIN_MS;
    if (remainingMs < HookConfig.PRE_WRITE_SUBPROCESS_FLOOR_MS) {
      logDuplicateGateIssue(
        pluginData,
        DUPLICATE_GATE_TIMEOUT_CODE,
        'budget',
        `no budget for subprocess fallback (${elapsedMs}ms elapsed)`,
        { budget_ms: budgetMs, elapsed_ms: elapsedMs },
      );
      return SCAN_FAILED;
    }

    subprocessT0 = Date.now();
    const out = execFileSync(
      binary.bin,
      ['reflect-scan', dbPath, title, '--top', '1', '--candidates', '5'],
      {
        encoding: 'utf-8',
        timeout: remainingMs,
        env: ortSpawnEnv(binary.binDir),
      },
    );
    return interpretScanResult(JSON.parse(out), filePath, vaultRoot, relPath, pending);
  } catch (err) {
    // ETIMEDOUT / SIGTERM from execFileSync's timeout is the silent-disable
    // failure mode — log it distinctly too, on top of the generic error log.
    if (err && (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM')) {
      logDuplicateGateIssue(
        pluginData,
        DUPLICATE_GATE_TIMEOUT_CODE,
        'subprocess',
        err.code || err.signal,
        { latency_ms: Date.now() - subprocessT0 },
      );
    }
    logError('pre-write-check.checkDuplicateNote', err);
    return SCAN_FAILED;
  }
}

// stdout carries exactly one PreToolUse decision, but one call can gate several
// files (a Codex apply_patch). So verdicts are recorded, not emitted, and a deny
// anywhere in the patch outranks an advisory anywhere else — otherwise a broken
// wikilink in file 1 would silently let a contract violation in file 2 through.
let verdict = null;

function deny(reason) {
  if (verdict?.kind === 'deny') return;
  verdict = { kind: 'deny', text: reason };
}

function warn(context) {
  if (verdict) return;
  verdict = { kind: 'warn', text: context };
}

function emitVerdict() {
  if (!verdict) return;
  emitJson({
    hookSpecificOutput:
      verdict.kind === 'deny'
        ? {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: verdict.text,
          }
        : { hookEventName: 'PreToolUse', additionalContext: verdict.text },
  });
}

// The note before and after this write. A Write replaces the file, so before is
// what is on disk (null for a new note). An Edit carries fragments, so the
// post-edit note is rebuilt from disk and every check sees the same body-only
// semantics as a Write: frontmatter excluded, Source:/Related: prefixes visible
// even when the fragment omits them. When the file can't be read, or
// old_string is empty, only the fragments can be judged, and `whole` is false:
// a fragment carries no frontmatter to check. An Edit whose old_string is not
// on disk fails in the Edit tool itself, so there is nothing to gate.
function proposedChange(tool, input) {
  const filePath = input.file_path;
  if (tool === 'Write') {
    return {
      beforeText: existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null,
      afterText: input.content || '',
      whole: true,
    };
  }
  const oldString = input.old_string || '';
  const newString = input.new_string || '';
  if (oldString) {
    let disk = null;
    try {
      disk = readFileSync(filePath, 'utf-8');
    } catch {
      disk = null;
    }
    if (disk !== null) {
      // An apply_patch hunk (the only entry with a `context` key) is wrapped in
      // newlines so it matches whole lines, but a file's first line has no
      // newline before it, and its last line none after it when the file has
      // no final newline. So the hunk is located in the file padded with a
      // newline on each side, and the padding comes off the result.
      const pad = 'context' in input ? '\n' : '';
      const text = pad + disk + pad;
      // The hunk also carries the `@@` anchor it occurs strictly after.
      // Searching from the anchor is what stops a hunk removing a body line
      // from binding to an identical line in the frontmatter.
      const anchor = input.context ? text.indexOf(input.context) : -1;
      const idx = text.indexOf(oldString, anchor === -1 ? 0 : anchor + input.context.length);
      if (idx === -1) return null;
      if (input.replace_all) {
        return { beforeText: disk, afterText: disk.split(oldString).join(newString), whole: true };
      }
      const edited = text.slice(0, idx) + newString + text.slice(idx + oldString.length);
      return {
        beforeText: disk,
        afterText: edited.slice(pad.length, edited.length - pad.length),
        whole: true,
      };
    }
  }
  return { beforeText: oldString, afterText: newString, whole: false };
}

function duplicateTags(fm) {
  return fm ? findDuplicateTags(parseTags(fm)) : [];
}

// Dash lines in `afterBody` that `beforeBody` doesn't already carry, matched
// by text, so the denial names what this write added.
function addedDashLines(beforeBody, afterBody) {
  const carried = new Map();
  for (const { text } of findEmDashLines(beforeBody)) {
    carried.set(text, (carried.get(text) || 0) + 1);
  }
  return findEmDashLines(afterBody).filter(({ text }) => {
    const n = carried.get(text) || 0;
    if (n > 0) carried.set(text, n - 1);
    return n === 0;
  });
}

function dashDenial(lines) {
  const list = lines.map((l) => `  line ${l.line}: ${l.text}`).join('\n');
  return (
    `This write adds em/en-dashes to body prose (persona voice rule "no em dashes, no en dashes"):\n${list}\n` +
    `Replace each with a comma, colon, or semicolon. If the dash is structural ` +
    `annotation (reference + gloss), move it to a Source: or Related: line, which are exempt.`
  );
}

// Wikilinks this write adds that name no note in the vault.
function brokenLinkWarning(beforeBody, afterBody, vaultRoot) {
  const carried = new Set(extractWikilinks(beforeBody));
  const added = extractWikilinks(afterBody).filter((l) => !carried.has(l));
  // Only pay for the snapshot load (a multi-hundred-KB JSON parse, or a full
  // vault readdir on TTL expiry) when there are wikilinks to validate.
  if (added.length === 0) return null;
  const noteIndex = buildNoteIndex(vaultRoot);
  const broken = added.filter((l) => {
    const target = l.split('#')[0].trim();
    return target && !noteExistsInIndex(target, noteIndex);
  });
  if (broken.length === 0) return null;
  return `Broken wikilinks: ${broken.map((l) => '[[' + l + ']]').join(', ')} not found in vault.`;
}

// Every check judges only what the write adds, for the reason frontmatterDenial
// gives. A new note inherits nothing, so the contract applies to it in full.
async function checkWrite(tool, input) {
  if (tool !== 'Write' && tool !== 'Edit') return;

  const filePath = input.file_path;
  if (!filePath) return;

  const vaultRoot = getVaultPath();
  if (!isVaultNote(filePath, vaultRoot)) return;

  const change = proposedChange(tool, input);
  if (!change) return;
  const { beforeText, afterText, whole } = change;

  let beforeBody = beforeText ?? '';
  let afterBody = afterText;
  if (whole) {
    const before = beforeText === null ? null : parseFrontmatter(beforeText);
    const after = parseFrontmatter(afterText);
    beforeBody = before?.body ?? '';
    afterBody = after.body;

    const carried = new Set(duplicateTags(before?.fm));
    const dupes = duplicateTags(after.fm).filter((t) => !carried.has(t));
    if (dupes.length > 0) {
      deny(`Duplicate tags found: [${dupes.join(', ')}]. Remove duplicates before writing.`);
      return;
    }

    const schemaDenial = frontmatterDenial(before?.fm ?? null, after.fm, filePath, vaultRoot);
    if (schemaDenial) {
      deny(schemaDenial);
      return;
    }
  }

  if (countExposedDashes(afterBody) > countExposedDashes(beforeBody)) {
    const added = addedDashLines(beforeBody, afterBody);
    deny(dashDenial(added.length > 0 ? added : findEmDashLines(afterBody)));
    return;
  }

  const warnings = [];
  const linkWarning = brokenLinkWarning(beforeBody, afterBody, vaultRoot);
  if (linkWarning) warnings.push(linkWarning);

  // Filename style and the duplicate-note scan judge a note by its name and
  // title, which only a Write carries whole.
  if (tool === 'Write') {
    const elapsedForStyle = Date.now() - HOOK_START_MS;
    const budgetOkForStyle =
      preWriteBudgetMs() - elapsedForStyle > HookConfig.PRE_WRITE_SAFETY_MARGIN_MS;
    const styleAdvisory = checkFilenameStyle(
      filePath,
      vaultRoot,
      getConfig(),
      beforeText !== null,
      budgetOkForStyle,
    );
    if (styleAdvisory) warnings.push(styleAdvisory);

    const titleMatch = afterText.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : null;
    const dupeResult = title ? await checkDuplicateNote(filePath, title, vaultRoot) : null;
    if (dupeResult === SCAN_FAILED) {
      if (preWriteFailMode(getConfig()) === 'closed') {
        deny(
          'Duplicate scan failed and pre_write_fail_mode is "closed"; blocking write. ' +
            'Re-run when the scan infrastructure is available, or set pre_write_fail_mode to "open" to allow writes on scan failure.',
        );
        return;
      }
    } else if (dupeResult) {
      warnings.push(dupeResult);
    }
  }

  if (warnings.length > 0) {
    warn(warnings.join('\n'));
  }
}

// One PreToolUse call can carry more than one file: Codex sends a whole
// apply_patch where Claude Code sends a single Write or Edit. Gate every file,
// stopping only once something is denied — nothing can outrank a deny, and
// stopping at the first advisory would let later violations through.
// Guarded so that IMPORTING this module does not RUN the hook. runHook reads
// stdin the moment it is called, so a test importing outerDeadlineMs or the
// gate error codes otherwise blocks until stdin closes -- which under
// `node --test` is never, and the suite hangs with no failing assertion.
//
// isMainModule realpaths both sides. Node resolves an ESM entry to its realpath
// for import.meta.url while process.argv[1] keeps the path the caller spelled,
// so a naive comparison is false under any symlinked install -- and here that
// means the write gate exits 0 having checked nothing. See lib/is-main.mjs.
if (isMainModule(import.meta.url)) {
  runHook(async ({ raw }) => {
    for (const write of normalizeWrites(raw)) {
      if (write.tool === 'Delete') continue;
      await checkWrite(write.tool, write);
      if (verdict?.kind === 'deny') break;
    }
    emitVerdict();
  });
}
