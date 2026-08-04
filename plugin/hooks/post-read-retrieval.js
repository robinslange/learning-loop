#!/usr/bin/env node
// post-read-retrieval.js — Track actual memory file reads (not just presence)

import { runHook, emitRetrieval } from './lib/common.mjs';

const MEMORY_RE = /[/\\]\.claude[/\\]projects[/\\][^/\\]+[/\\]memory[/\\](.+\.md)$/;
const MARKDOWN_ARG = /[^\s'"`;|&<>()]+\.md/g;

// Claude Code names the file in tool_input.file_path. Codex has no Read
// function tool at all — reads land in the shell — so there the candidates are
// whatever markdown paths the command mentions. That is an approximation, and
// it only ever feeds retrieval telemetry, never a gate.
function candidatePaths(tool, input) {
  if (input?.file_path) return [input.file_path];
  if (tool !== 'Bash') return [];
  return String(input?.command || '').match(MARKDOWN_ARG) || [];
}

runHook(({ tool, input }) => {
  const seen = new Set();
  for (const path of candidatePaths(tool, input)) {
    const match = path.match(MEMORY_RE);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    emitRetrieval('reads', { type: 'memory-read', file: match[1] });
  }
});
