#!/usr/bin/env node
// retraction-notify.mjs — Emit a retraction event to the federation outbox.
//
// Usage:
//   node retraction-notify.mjs <note_path> [--reason "<reason>"] [--replacement <new_note_path>] [--source-graph local]
//
// Writes an append-only JSONL event to PLUGIN_DATA/federation/outbox/retractions-YYYY-MM.jsonl.
// For each peer in federation/config.json whose index.db contains the retracted note,
// the event is marked as targeted to that peer.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { appendJsonlLine } from './lib/jsonl.mjs';
import { join, dirname } from 'path';
import { initSQL } from './lib/sqljs.mjs';
import { PLUGIN_DATA } from './lib/constants.mjs';
import { safeLoad } from './lib/safe-load.mjs';
import { logError } from './lib/log.mjs';
import { FEDERATION_PATHS } from './lib/paths.mjs';

const FEDERATION_DIR = FEDERATION_PATHS.root(PLUGIN_DATA);
const OUTBOX_DIR = FEDERATION_PATHS.outbox(PLUGIN_DATA);
const PEERS_DIR = FEDERATION_PATHS.peersDir(PLUGIN_DATA);
const CONFIG_PATH = FEDERATION_PATHS.config(PLUGIN_DATA);

const args = process.argv.slice(2);

function parseFlag(flag, defaultVal) {
  const idx = args.indexOf(flag);
  if (idx < 0) return defaultVal;
  return args[idx + 1] !== undefined ? args[idx + 1] : defaultVal;
}

function out(data) {
  console.log(JSON.stringify(data, null, 2));
}

function usage() {
  out({
    error:
      'Usage: retraction-notify <note_path> [--reason "<reason>"] [--replacement <new_path>] [--source-graph local]',
  });
  process.exit(1);
}

const notePath = args[0];
if (!notePath || notePath.startsWith('--')) usage();

const reason = parseFlag('--reason', null);
const replacement = parseFlag('--replacement', null);
const sourceGraph = parseFlag('--source-graph', 'local');

async function peerHasNote(peerId, notePath) {
  const dbPath = FEDERATION_PATHS.peerDb(PLUGIN_DATA, peerId);
  if (!existsSync(dbPath)) return false;
  try {
    const SQL = await initSQL();
    const buffer = readFileSync(dbPath);
    const db = new SQL.Database(buffer);
    const normalized = notePath.replace(/\\/g, '/');
    const result = db.exec(
      "SELECT 1 FROM notes WHERE path = ? OR REPLACE(path, '\\', '/') = ? LIMIT 1",
      [normalized, normalized],
    );
    db.close();
    return result.length > 0 && result[0].values.length > 0;
  } catch (err) {
    logError('retraction-notify.peerHasNote', err);
    return false;
  }
}

function loadPeers() {
  const { value: config, error } = safeLoad(CONFIG_PATH, { fallback: null });
  if (error || !config) {
    if (error) logError('retraction-notify.loadPeers', error);
    return [];
  }
  return config.peers || [];
}

function listIndexedPeerIds() {
  if (!existsSync(PEERS_DIR)) return [];
  try {
    return readdirSync(PEERS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

async function main() {
  if (!existsSync(FEDERATION_DIR)) {
    out({ ok: false, reason: 'federation not configured', note: notePath });
    process.exit(0);
  }

  const peers = loadPeers();
  const indexedPeers = listIndexedPeerIds();

  const candidatePeerIds = new Set([...peers.map((p) => p.id), ...indexedPeers]);

  const targets = [];
  for (const peerId of candidatePeerIds) {
    if (await peerHasNote(peerId, notePath)) {
      targets.push(peerId);
    }
  }

  const event = {
    type: 'retraction',
    ts: new Date().toISOString(),
    note_path: notePath,
    source_graph: sourceGraph,
    reason,
    replacement_note_path: replacement,
    targets,
  };

  mkdirSync(OUTBOX_DIR, { recursive: true });
  const month = new Date().toISOString().slice(0, 7);
  const outboxFile = join(OUTBOX_DIR, `retractions-${month}.jsonl`);
  appendJsonlLine(outboxFile, event);

  out({
    ok: true,
    event,
    outbox: outboxFile,
    targeted_peers: targets.length,
    skipped_peers: candidatePeerIds.size - targets.length,
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
