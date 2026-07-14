#!/usr/bin/env node
// subagent-stop.js — Emit agent-result provenance when a subagent stops.

import { readStdin, emitProvenance } from './lib/common.mjs';
import { logError } from '../scripts/lib/log.mjs';

const raw = await readStdin();
if (!raw.trim()) process.exit(0);

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  logError('subagent-stop.parseStdin', err);
  process.exit(0);
}

const { session_id, transcript_path } = parsed;

emitProvenance({
  action: 'agent-result',
  ...(session_id ? { session_id } : {}),
  ...(transcript_path ? { transcript_path } : {}),
});
