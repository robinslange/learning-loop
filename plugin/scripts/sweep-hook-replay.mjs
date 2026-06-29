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

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = resolve(__dirname, '..', 'hooks', 'post-tool.js');
const PER_FILE_TIMEOUT_MS = 15000;

// /reflect Step 4.4 candidate folders — an explicit ALLOWLIST. Do NOT swap this
// for lib/vault-walk.mjs#listVaultNotes: that is a denylist (excludes only
// _archive/_archived/Excalidraw) and would sweep 4-projects free-form index
// notes the python walk deliberately skipped, mis-attributing them.
const SWEEP_FOLDERS = ['0-inbox', '1-fleeting', '2-literature', '3-permanent', '5-maps'];

// Candidate union for the 4.4 sweep, mirroring the old python walk exactly:
//   (1) notes whose BODY has no [[wikilink]]  -> autolink/edge-infer backfill
//   (2) notes whose frontmatter reflect_sid == this session's sid
//         -> marker backfill for sub-agent writes the live hook missed
// A note matching either set is emitted once. Returns absolute paths.
export function scanVaultCandidates(vaultRoot, sid) {
  const seen = new Set();
  const sidRe = sid
    ? new RegExp(
        `^reflect_sid:\\s*["']?${sid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*$`,
        'm',
      )
    : null;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && e.name.endsWith('.md') && !seen.has(p)) {
        let text;
        try {
          text = readFileSync(p, 'utf-8');
        } catch {
          continue;
        }
        const fmMatch = /^---\n([\s\S]*?)\n---\n/.exec(text);
        const fm = fmMatch ? fmMatch[1] : '';
        const body = fmMatch ? text.slice(fmMatch[0].length) : text;
        const unlinked = !/\[\[[^\]]+\]\]/.test(body);
        const mine = sidRe ? sidRe.test(fm) : false;
        if (unlinked || mine) seen.add(p);
      }
    }
  };
  for (const folder of SWEEP_FOLDERS) walk(join(vaultRoot, folder));
  return [...seen];
}

function readStdinPaths() {
  const raw = readFileSync(0, 'utf-8');
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function replayOne(absPath) {
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

  // Forward LL_REFLECT_SID explicitly so the replayed post-tool.js appends to
  // the CALLING reflect session's new-notes marker. spawnSync inherits env by
  // default, but we pass it deliberately to document the handshake: /reflect
  // Step 4.4 sets LL_REFLECT_SID=$LL_SID before invoking this script, and the
  // replayed reflect-track.mjs uses it as the explicit session override. This is
  // what makes subagent-written notes reach the marker, and what keeps that
  // attribution correct when multiple /reflect runs overlap.
  const result = spawnSync('node', [HOOK_PATH], {
    input: stdin,
    encoding: 'utf-8',
    timeout: PER_FILE_TIMEOUT_MS,
    env: process.env,
  });
  if (result.status !== 0) {
    return {
      path: absPath,
      ok: false,
      reason: `post-tool.js exit ${result.status}`,
      stderr: (result.stderr || '').trim().slice(0, 500),
    };
  }
  return { path: absPath, ok: true };
}

function main() {
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
    const result = replayOne(abs);
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
  main();
}
