#!/usr/bin/env node
// provenance-emit.js : cross-platform fire-and-forget wrapper for provenance.mjs
//
// Three call shapes, in order of preference:
//
//   1. node provenance-emit.js '{"agent":"verify","action":"session-start"}'
//      The normal form. Fine whenever no field carries prose.
//
//   2. node provenance-emit.js '{"action":"score",...}' --text finding_detail "any prose here"
//      For ONE free-text field. The prose arrives as its own argv entry, so the
//      caller never escapes JSON inside it: no doubled backslashes, no escaped
//      quotes, no shell-quoting hazard from backticks or $. This is the shape to
//      reach for when a field holds a sentence a human wrote.
//
//   3. node provenance-emit.js - <<'JSON'   (payload, or one payload per line)
//      Stdin form, retained for batching: usage-provenance emits one line per
//      note in a single call. A quoted heredoc still needs JSON-escaped prose,
//      which is why shape 2 exists for the single-event case.
//
// Replaces provenance-emit.sh for Windows compatibility.

import { readFileSync } from 'node:fs';
import { emitProvenance } from './provenance.mjs';
import { logError } from './lib/log.mjs';

const argv = process.argv.slice(2);
if (argv.length === 0) process.exit(0);

// --text <field> <value> attaches one free-text field without the caller
// having to escape it into the JSON. Parsed off the end so the JSON argument
// stays in its usual position.
function takeTextFlag(args) {
  const i = args.indexOf('--text');
  if (i === -1) return { args, field: null, value: null };
  return {
    args: args.slice(0, i),
    field: args[i + 1] ?? null,
    value: args[i + 2] ?? null,
  };
}

try {
  const { args, field, value } = takeTextFlag(argv);
  const arg = args[0];
  if (!arg) process.exit(0);
  const payload = arg === '-' ? readFileSync(0, 'utf-8') : arg;

  // Stdin may carry several newline-separated events (the batching case).
  const lines = payload
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const event = JSON.parse(line);
    if (field && value !== null) event[field] = value;
    emitProvenance(event);
  }
} catch (err) {
  logError('provenance-emit', err);
}
