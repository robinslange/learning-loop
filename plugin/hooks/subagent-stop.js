#!/usr/bin/env node
// subagent-stop.js — Emit agent-result provenance when a subagent stops.

import { readPayload, emitProvenance } from './lib/common.mjs';

const payload = await readPayload('subagent-stop');
if (!payload) process.exit(0);

const { session_id, transcript_path } = payload;

emitProvenance({
  action: 'agent-result',
  ...(session_id ? { session_id } : {}),
  ...(transcript_path ? { transcript_path } : {}),
});
