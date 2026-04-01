#!/usr/bin/env node
// provenance-emit.js — Cross-platform fire-and-forget wrapper for provenance.mjs
// Usage: node provenance-emit.js '{"agent":"verify","action":"session-start"}'
// Replaces provenance-emit.sh for Windows compatibility.

import { emitProvenance } from './provenance.mjs';

const arg = process.argv[2];
if (!arg) process.exit(0);

try {
  emitProvenance(JSON.parse(arg));
} catch {
  // Fire-and-forget: never block the caller
}
