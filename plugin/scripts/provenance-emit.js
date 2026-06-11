#!/usr/bin/env node
// provenance-emit.js — Cross-platform fire-and-forget wrapper for provenance.mjs
// Usage: node provenance-emit.js '{"agent":"verify","action":"session-start"}'
//    or: node provenance-emit.js - <<'JSON'   (payload on stdin; use for events
//        carrying free-text fields so prose can't break shell quoting)
// Replaces provenance-emit.sh for Windows compatibility.

import { readFileSync } from 'node:fs';
import { emitProvenance } from './provenance.mjs';
import { logError } from './lib/log.mjs';

const arg = process.argv[2];
if (!arg) process.exit(0);

try {
  const payload = arg === '-' ? readFileSync(0, 'utf-8') : arg;
  emitProvenance(JSON.parse(payload));
} catch (err) {
  logError('provenance-emit', err);
}
