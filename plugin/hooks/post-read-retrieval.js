#!/usr/bin/env node
// post-read-retrieval.js — Track actual memory file reads (not just presence)

import { runHook, emitRetrieval } from './lib/common.mjs';

const MEMORY_RE = /[/\\]\.claude[/\\]projects[/\\][^/\\]+[/\\]memory[/\\](.+\.md)$/;

runHook(({ input }) => {
  const match = input.file_path?.match(MEMORY_RE);
  if (match) emitRetrieval('reads', { type: 'memory-read', file: match[1] });
});
