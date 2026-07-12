#!/usr/bin/env node
// sweep-hook-replay.mjs — Replay the post-tool dispatcher on vault notes.
//
// Background: PostToolUse hooks don't fire on subagent Write/Edit tool calls.
// Notes written by note-writer, discovery-researcher, literature-capturer,
// etc. bypass the structural backlink and typed-edge infrastructure entirely.
// This script invokes hooks/post-tool.js (the coalesced dispatcher running
// provenance + reflect-track + autolink + edge-infer) on one or more vault
// notes as if a main-thread Write had triggered it.
//
// Used by the post-batch sweep step in /reflect and /ingest, and by backfill
// runs for historical unhooked notes.
//
// Usage:
//   sweep-hook-replay.mjs <file> [<file> ...]
//   sweep-hook-replay.mjs --stdin                 # read newline-separated paths
//   sweep-hook-replay.mjs --scan-vault <root> --sid <sid>
//                                                 # compute the /reflect 4.4
//                                                 # candidate union, then replay
//
// The dispatcher's modules are idempotent (autolink checks for existing
// [[links]] before appending; edge-infer removes outgoing edges before
// re-adding), so running on already-hooked notes is safe.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFrontmatter } from './lib/markdown-parse.mjs';
import { listVaultNotes } from './lib/vault-walk.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = resolve(__dirname, '..', 'hooks', 'post-tool.js');
const HOOK_URL = pathToFileURL(HOOK_PATH).href;
const PER_FILE_TIMEOUT_MS = 15000;

// /reflect Step 4.4 candidate folders: an explicit ALLOWLIST, passed to
// lib/vault-walk.mjs#listVaultNotes as its `dirs` restriction. Do NOT drop the
// restriction: the lib's default denylist walk would sweep 4-projects
// free-form index notes the python walk deliberately skipped, mis-attributing
// them.
const SWEEP_FOLDERS = ['0-inbox', '1-fleeting', '2-literature', '3-permanent', '5-maps'];

// Candidate union for the 4.4 sweep, mirroring the old python walk exactly:
//   (1) notes whose BODY has no [[wikilink]]  -> autolink/edge-infer backfill
//   (2) notes whose frontmatter reflect_sid == this session's sid
//         -> marker backfill for sub-agent writes the live hook missed
// A note matching either set is emitted once. Returns absolute paths.
export function scanVaultCandidates(vaultRoot, sid) {
  const out = [];
  for (const { path } of listVaultNotes(vaultRoot, { dirs: SWEEP_FOLDERS })) {
    let text;
    try {
      text = readFileSync(path, 'utf-8');
    } catch {
      continue;
    }
    const { fm, body } = parseFrontmatter(text);
    const unlinked = !/\[\[[^\]]+\]\]/.test(body);
    const mine = sid ? fm.reflect_sid === sid : false;
    if (unlinked || mine) out.push(path);
  }
  return out;
}

function readStdinPaths() {
  const raw = readFileSync(0, 'utf-8');
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

// In-process replay. hooks/post-tool.js is a stdin-fed top-level-await script,
// not a callable module: it reads its payload from process.stdin at import
// time. Each replay therefore swaps process.stdin for a one-shot readable
// carrying the payload and imports a fresh (cache-busted) copy of the
// dispatcher; its static imports stay warm in the module cache, which is the
// whole win over one cold node spawn per note.
//
// LL_REFLECT_SID handshake: /reflect Step 4.4 sets LL_REFLECT_SID=$LL_SID
// before invoking this script, and the replayed post-tool.js reads it from
// this same process's env, so subagent-written notes reach the CALLING reflect
// session's new-notes marker and attribution stays correct when multiple
// /reflect runs overlap.

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
let replaySeq = 0;

function setFakeStdin(text) {
  Object.defineProperty(process, 'stdin', {
    value: Readable.from([text]),
    configurable: true,
  });
}

function restoreStdin() {
  if (realStdin) Object.defineProperty(process, 'stdin', realStdin);
}

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}

async function replayOne(absPath) {
  let content;
  try {
    content = readFileSync(absPath, 'utf-8');
  } catch (err) {
    return { path: absPath, ok: false, reason: `read failed: ${err.message}` };
  }

  const stdin = JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: absPath, content },
    tool_response: { success: true },
  });

  setFakeStdin(stdin);
  try {
    await withTimeout(import(`${HOOK_URL}?replay=${replaySeq++}`), PER_FILE_TIMEOUT_MS);
    return { path: absPath, ok: true };
  } catch (err) {
    return { path: absPath, ok: false, reason: `post-tool.js failed: ${err.message}` };
  } finally {
    restoreStdin();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const wantsHelp = args.includes('--help') || args.includes('-h');
  if (args.length === 0 || wantsHelp) {
    const helpText = `sweep-hook-replay.mjs <file> [<file> ...]
sweep-hook-replay.mjs --stdin                 Read newline-separated paths from stdin
sweep-hook-replay.mjs --scan-vault <root> --sid <sid>
                                              Compute the /reflect 4.4 candidate
                                              union (link-less OR reflect_sid==sid,
                                              5-folder allowlist) then replay

Invokes the post-tool dispatcher (hooks/post-tool.js) on one or more vault
notes, running provenance + reflect-track + autolink + edge-infer in fixed
order. Used after subagent writes to compensate for PostToolUse hooks not
firing on subagent tool calls.

Output: JSON summary {processed, ok, failed, failures}. Exit code 0 on full
success, 1 if any file failed, 2 on usage error.
`;
    if (wantsHelp) {
      process.stdout.write(helpText);
      process.exit(0);
    }
    process.stderr.write(helpText);
    process.exit(2);
  }

  let paths;
  if (args.includes('--scan-vault')) {
    const root = args[args.indexOf('--scan-vault') + 1];
    const sidIdx = args.indexOf('--sid');
    const sid = sidIdx >= 0 ? args[sidIdx + 1] : '';
    if (!root || root.startsWith('--')) {
      process.stderr.write('--scan-vault requires a vault root path (got none or a flag)\n');
      process.exit(2);
    }
    if (sidIdx >= 0 && (!sid || sid.startsWith('--'))) {
      process.stderr.write('--sid requires a session id (got none or a flag)\n');
      process.exit(2);
    }
    paths = scanVaultCandidates(resolve(root), sid);
  } else if (args.includes('--stdin')) {
    paths = readStdinPaths();
  } else {
    paths = args.filter((a) => !a.startsWith('--'));
  }

  if (paths.length === 0) {
    process.stdout.write(JSON.stringify({ processed: 0, ok: 0, failed: 0, failures: [] }) + '\n');
    return;
  }

  const failures = [];
  let ok = 0;
  for (const p of paths) {
    const abs = resolve(p);
    if (!existsSync(abs)) {
      failures.push({ path: abs, reason: 'file not found' });
      continue;
    }
    const result = await replayOne(abs);
    if (result.ok) ok++;
    else failures.push(result);
  }

  const summary = {
    processed: paths.length,
    ok,
    failed: failures.length,
    failures: failures.slice(0, 20),
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.exit(failures.length > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
