import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { initSQL } from '../scripts/lib/sqljs.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'retraction-notify.mjs');
const PLUGIN_DATA = '/tmp/ll-test-plugin-data-retraction';
const FEDERATION_DIR = join(PLUGIN_DATA, 'federation');
const PEERS_DIR = join(FEDERATION_DIR, 'data', 'peers');
const OUTBOX_DIR = join(FEDERATION_DIR, 'outbox');
const CONFIG_PATH = join(FEDERATION_DIR, 'config.json');

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
    mkdirSync(PEERS_DIR, { recursive: true });
  });

  after(() => {
    rmSync(PLUGIN_DATA, { recursive: true, force: true });
  });

  it('targets only peers whose index contains the note', async () => {
    await makePeerIndex('alice', ['3-permanent/shared.md', '3-permanent/other.md']);
    await makePeerIndex('bob', ['3-permanent/different.md']);

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
    runScript(['3-permanent/note.md', '--reason', 'first']);
    runScript(['3-permanent/note.md', '--reason', 'second']);
    const events = readOutbox();
    assert.equal(events.length, 2);
    assert.equal(events[0].reason, 'first');
    assert.equal(events[1].reason, 'second');
  });

  it('records empty targets when no peer has the note', async () => {
    await makePeerIndex('alice', ['3-permanent/other.md']);
    const result = runScript(['3-permanent/orphan.md']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.event.targets, []);
    assert.equal(result.targeted_peers, 0);
  });

  it('includes replacement and source_graph in event', async () => {
    await makePeerIndex('alice', ['3-permanent/old.md']);
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
    const result = runScript(['3-permanent/note.md']);
    assert.deepEqual(result.event.targets, ['charlie']);
  });
});
