import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { initSQL } from '../plugin/scripts/lib/sqljs.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'plugin', 'scripts', 'retraction-notify.mjs');
const PLUGIN_DATA = join(tmpdir(), `ll-test-plugin-data-retraction-${randomBytes(8).toString('hex')}`);
const FEDERATION_DIR = join(PLUGIN_DATA, 'federation');
const PEERS_DIR = join(FEDERATION_DIR, 'data', 'peers');
const OUTBOX_DIR = join(FEDERATION_DIR, 'outbox');
const CONFIG_PATH = join(FEDERATION_DIR, 'config.json');
const READABLE_VAULTS_PATH = join(FEDERATION_DIR, 'readable-vaults.json');

async function makePeerIndex(peerId, notePaths) {
  mkdirSync(join(PEERS_DIR, peerId), { recursive: true });
  const SQL = await initSQL();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      tags TEXT,
      tier TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  for (const p of notePaths) {
    db.run('INSERT INTO notes (path, title, tier, updated_at) VALUES (?, ?, ?, ?)', [p, p, 'public', 0]);
  }
  const data = db.export();
  writeFileSync(join(PEERS_DIR, peerId, 'index.db'), Buffer.from(data));
  db.close();
}

// The hub's last ruling on what this key may read. Every peer cache these
// tests plant needs a line here, because a cache is not authority on its own.
function listReadable(vaultIds) {
  writeFileSync(READABLE_VAULTS_PATH, JSON.stringify({ at: 1, vault_ids: vaultIds }));
}

function runScript(args) {
  const out = execFileSync('node', [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: PLUGIN_DATA },
    timeout: 8000,
  });
  return JSON.parse(out);
}

function readOutbox() {
  const month = new Date().toISOString().slice(0, 7);
  const file = join(OUTBOX_DIR, `retractions-${month}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

describe('retraction-notify', () => {
  before(() => {
    mkdirSync(PEERS_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({
      identity: { displayName: 'test', pubkey: 'ed25519:fake' },
      peers: [
        { id: 'alice', pubkey: 'ed25519:alice' },
        { id: 'bob', pubkey: 'ed25519:bob' },
      ],
    }));
  });

  beforeEach(() => {
    if (existsSync(OUTBOX_DIR)) rmSync(OUTBOX_DIR, { recursive: true, force: true });
    if (existsSync(PEERS_DIR)) rmSync(PEERS_DIR, { recursive: true, force: true });
    rmSync(READABLE_VAULTS_PATH, { force: true });
    mkdirSync(PEERS_DIR, { recursive: true });
  });

  after(() => {
    rmSync(PLUGIN_DATA, { recursive: true, force: true });
  });

  it('targets only peers whose index contains the note', async () => {
    await makePeerIndex('alice', ['3-permanent/shared.md', '3-permanent/other.md']);
    await makePeerIndex('bob', ['3-permanent/different.md']);
    listReadable(['alice', 'bob']);

    const result = runScript(['3-permanent/shared.md', '--reason', 'wrong']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.event.targets, ['alice']);
    assert.equal(result.event.note_path, '3-permanent/shared.md');
    assert.equal(result.event.reason, 'wrong');
    assert.equal(result.targeted_peers, 1);
    assert.equal(result.skipped_peers, 1);
  });

  it('writes retraction events to outbox JSONL', async () => {
    await makePeerIndex('alice', ['3-permanent/note.md']);
    listReadable(['alice']);
    runScript(['3-permanent/note.md', '--reason', 'first']);
    runScript(['3-permanent/note.md', '--reason', 'second']);
    const events = readOutbox();
    assert.equal(events.length, 2);
    assert.equal(events[0].reason, 'first');
    assert.equal(events[1].reason, 'second');
  });

  it('records empty targets when no peer has the note', async () => {
    await makePeerIndex('alice', ['3-permanent/other.md']);
    listReadable(['alice']);
    const result = runScript(['3-permanent/orphan.md']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.event.targets, []);
    assert.equal(result.targeted_peers, 0);
  });

  it('includes replacement and source_graph in event', async () => {
    await makePeerIndex('alice', ['3-permanent/old.md']);
    listReadable(['alice']);
    const result = runScript([
      '3-permanent/old.md',
      '--reason', 'corrected',
      '--replacement', '3-permanent/new.md',
      '--source-graph', 'robin',
    ]);
    assert.equal(result.event.replacement_note_path, '3-permanent/new.md');
    assert.equal(result.event.source_graph, 'robin');
  });

  it('returns ok=false when federation is not configured', () => {
    rmSync(FEDERATION_DIR, { recursive: true, force: true });
    const result = runScript(['3-permanent/anything.md']);
    assert.equal(result.ok, false);
    mkdirSync(PEERS_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ peers: [{ id: 'alice', pubkey: 'fake' }] }));
  });

  it('discovers peers from peers/ directory even if not in config', async () => {
    await makePeerIndex('charlie', ['3-permanent/note.md']);
    listReadable(['charlie']);
    const result = runScript(['3-permanent/note.md']);
    assert.deepEqual(result.event.targets, ['charlie']);
  });

  it('matches peer paths with backslash separators', async () => {
    const peerDir = join(PEERS_DIR, 'windows_peer');
    mkdirSync(peerDir, { recursive: true });
    const peerDb = join(peerDir, 'index.db');
    const SQL = await initSQL();
    const db = new SQL.Database();
    db.run('CREATE TABLE notes (id INTEGER PRIMARY KEY, path TEXT NOT NULL)');
    db.run('INSERT INTO notes (path) VALUES (?)', ['3-permanent\\sample-note.md']);
    writeFileSync(peerDb, Buffer.from(db.export()));
    db.close();

    listReadable(['windows_peer']);
    const result = runScript(['3-permanent/sample-note.md', '--reason', 'test']);
    assert.equal(result.ok, true);
    assert.equal(result.targeted_peers, 1);
    assert.deepEqual(result.event.targets, ['windows_peer']);
  });

  // This script is the SECOND way into federation/data/peers/. The Rust
  // reader gates every federated read on the hub's last listing; this one
  // enumerated the directory and opened each index.db, so on a machine whose
  // authority had been withdrawn it named the peer while the reader served
  // nothing. Same directory, two answers.
  //
  // Nothing delivers federation/outbox/ today, which is what keeps this a
  // latent trap rather than a live leak — and is exactly why it is worth
  // closing before something does.
  it('does not target a cached peer the hub no longer lists', async () => {
    await makePeerIndex('alice', ['3-permanent/shared.md']);
    listReadable([]);
    const result = runScript(['3-permanent/shared.md']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.event.targets, [], 'the cache is stale, not authority');
  });

  it('treats a missing listing as no authority rather than as an unknown', async () => {
    await makePeerIndex('alice', ['3-permanent/shared.md']);
    const result = runScript(['3-permanent/shared.md']);
    assert.deepEqual(result.event.targets, []);
  });

  it('treats an unreadable listing the same way', async () => {
    await makePeerIndex('alice', ['3-permanent/shared.md']);
    writeFileSync(READABLE_VAULTS_PATH, '{not json');
    const result = runScript(['3-permanent/shared.md']);
    assert.deepEqual(result.event.targets, []);
  });
});
