#!/usr/bin/env node
// scripts/librarian.mjs : CLI entry point for the librarian daemon.
//
// Only supports --help/-h (shows usage) and zero-args (start daemon).
// No start/status subcommands — those do not exist in the real contract.
//
// SIGTERM/SIGINT: signals AbortController, gives 5s for state drain, then exits.
// __test__ surface preserved for existing bust-import tests.

import { fileURLToPath } from 'node:url';
import { runDaemon, investigateNote } from './librarian/daemon.mjs';
import { waitForOllama } from './librarian/ollama-client.mjs';
import { voiceCheck } from './librarian/tools/voice.mjs';
import { tagCheck } from './librarian/tools/tag-suggest.mjs';
import { duplicateCheck } from './librarian/tools/duplicate.mjs';
import { logError, info } from './lib/log.mjs';

const HELP_TEXT = `librarian.mjs

Long-running vault librarian daemon. Investigates notes that need attention
(low quality, missing tags, duplicates) using the local Ollama model.

Configuration: config.json -> librarian section
  enabled, model, pace_seconds, queue_cap, ...

Logs:    PLUGIN_DATA/librarian/librarian.log
State:   PLUGIN_DATA/librarian/state.json

This script runs until interrupted. There are no positional arguments.
`;

async function cli() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  const ac = new AbortController();
  let drainTimer = null;

  const onSignal = (name) => {
    info('librarian', 'received ' + name + ', draining (5s budget)');
    ac.abort();
    drainTimer = setTimeout(() => process.exit(0), 5000);
    drainTimer.unref();
  };

  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));

  try {
    await runDaemon({ signal: ac.signal });
    if (drainTimer) clearTimeout(drainTimer);
    process.exit(0);
  } catch (err) {
    logError('librarian', err);
    process.exit(err.code === 'OLLAMA_UNREACHABLE' ? 2 : 1);
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) cli();

// Test surface: __test__ must remain on this module for existing bust-import tests.
export const __test__ = { voiceCheck, tagCheck, duplicateCheck, waitForOllama, investigateNote };
