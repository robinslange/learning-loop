import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  openEdgeDb, addSupersession, removeSupersession,
  listSupersessions, findMatchingSupersessions, saveDb,
} from '../scripts/lib/edges.mjs';

const HOOK = join(import.meta.dirname, '..', 'hooks', 'post-search-tracking.js');
const PLUGIN_DATA = '/tmp/ll-test-plugin-data-super';
const DB_PATH = join(PLUGIN_DATA, 'edges.db');

function runHookWith(query) {
  const input = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__plugin_episodic-memory_episodic-memory__search',
    tool_input: { query },
    tool_response: { results: [] },
  });
  const out = execFileSync('node', [HOOK], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: PLUGIN_DATA },
    timeout: 5000,
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

describe('supersessions lib', () => {
  before(() => {
    mkdirSync(PLUGIN_DATA, { recursive: true });
  });

  beforeEach(() => {
    if (existsSync(DB_PATH)) rmSync(DB_PATH);
  });

  after(() => {
    rmSync(PLUGIN_DATA, { recursive: true, force: true });
  });

  it('adds and lists supersessions', async () => {
    const db = await openEdgeDb(DB_PATH);
    const id = addSupersession(db, {
      oldPatternQuery: 'always use mocks in tests',
      replacementNotePath: '3-permanent/integration-tests-must-hit-real-database.md',
      reason: 'mocked tests passed but prod migration failed',
    });
    saveDb(db, DB_PATH);
    const items = listSupersessions(db);
    db.close();
    assert.equal(items.length, 1);
    assert.equal(items[0].id, id);
    assert.equal(items[0].old_pattern_query, 'always use mocks in tests');
    assert.match(items[0].superseded_date, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('rejects empty pattern', async () => {
    const db = await openEdgeDb(DB_PATH);
    assert.throws(() => addSupersession(db, { oldPatternQuery: '' }));
    assert.throws(() => addSupersession(db, { oldPatternQuery: '   ' }));
    db.close();
  });

  it('rejects pattern with no content words after stopword removal', async () => {
    const db = await openEdgeDb(DB_PATH);
    assert.throws(
      () => addSupersession(db, { oldPatternQuery: 'how to do it' }),
      /no content words/,
    );
    db.close();
  });

  it('removes a supersession by id', async () => {
    const db = await openEdgeDb(DB_PATH);
    const id = addSupersession(db, { oldPatternQuery: 'old habit' });
    removeSupersession(db, id);
    saveDb(db, DB_PATH);
    assert.equal(listSupersessions(db).length, 0);
    db.close();
  });

  it('matches queries via token overlap with stopwords stripped', async () => {
    const db = await openEdgeDb(DB_PATH);
    addSupersession(db, { oldPatternQuery: 'always use mocks in tests' });
    saveDb(db, DB_PATH);

    assert.equal(findMatchingSupersessions(db, 'should I use mocks in my tests?').length, 1);
    assert.equal(findMatchingSupersessions(db, 'mocks in tests are useful').length, 1);
    db.close();
  });

  it('does not match weak overlap', async () => {
    const db = await openEdgeDb(DB_PATH);
    addSupersession(db, { oldPatternQuery: 'always use mocks in tests' });
    saveDb(db, DB_PATH);

    assert.equal(findMatchingSupersessions(db, 'tests are important').length, 0);
    assert.equal(findMatchingSupersessions(db, 'how do I deploy to production').length, 0);
    db.close();
  });

  it('returns empty for empty query', async () => {
    const db = await openEdgeDb(DB_PATH);
    addSupersession(db, { oldPatternQuery: 'something' });
    saveDb(db, DB_PATH);
    assert.equal(findMatchingSupersessions(db, '').length, 0);
    assert.equal(findMatchingSupersessions(db, '   ').length, 0);
    db.close();
  });

  it('matches single-content-token patterns when query contains the token', async () => {
    const db = await openEdgeDb(DB_PATH);
    addSupersession(db, { oldPatternQuery: 'deprecated' });
    saveDb(db, DB_PATH);
    assert.equal(findMatchingSupersessions(db, 'this approach is deprecated').length, 1);
    assert.equal(findMatchingSupersessions(db, 'unrelated query about apples').length, 0);
    db.close();
  });

  it('dedupes pattern tokens so duplicates do not inflate ratio', async () => {
    const db = await openEdgeDb(DB_PATH);
    const id = addSupersession(db, { oldPatternQuery: 'test test cases' });
    saveDb(db, DB_PATH);
    const matches = findMatchingSupersessions(db, 'test cases');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].id, id);
    assert.equal(matches[0].match_ratio, 1);
    db.close();
  });

  it('sorts matches by descending overlap ratio', async () => {
    const db = await openEdgeDb(DB_PATH);
    addSupersession(db, { oldPatternQuery: 'mocks tests' });
    addSupersession(db, { oldPatternQuery: 'mocks integration tests fixtures' });
    saveDb(db, DB_PATH);

    const matches = findMatchingSupersessions(db, 'use mocks in tests');
    assert.ok(matches.length >= 1);
    if (matches.length > 1) {
      assert.ok(matches[0].match_ratio >= matches[1].match_ratio);
    }
    db.close();
  });
});

describe('post-search-tracking supersession annotation', () => {
  before(() => {
    mkdirSync(PLUGIN_DATA, { recursive: true });
  });

  beforeEach(async () => {
    if (existsSync(DB_PATH)) rmSync(DB_PATH);
  });

  after(() => {
    rmSync(PLUGIN_DATA, { recursive: true, force: true });
  });

  it('emits annotation when query matches a supersession', async () => {
    const db = await openEdgeDb(DB_PATH);
    addSupersession(db, {
      oldPatternQuery: 'always use mocks in tests',
      replacementNotePath: '3-permanent/integration-tests-must-hit-real-database.md',
      reason: 'prod migration failed',
    });
    saveDb(db, DB_PATH);
    db.close();

    const result = runHookWith('should I use mocks in my tests');
    assert.ok(result);
    assert.equal(result.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(result.hookSpecificOutput.additionalContext, /superseded/);
    assert.match(result.hookSpecificOutput.additionalContext, /integration-tests-must-hit-real-database/);
  });

  it('emits nothing for unrelated queries', async () => {
    const db = await openEdgeDb(DB_PATH);
    addSupersession(db, { oldPatternQuery: 'always use mocks in tests' });
    saveDb(db, DB_PATH);
    db.close();

    const result = runHookWith('how do I render react components');
    assert.equal(result, null);
  });

  it('emits nothing when no supersessions exist', async () => {
    const db = await openEdgeDb(DB_PATH);
    saveDb(db, DB_PATH);
    db.close();
    const result = runHookWith('any query at all');
    assert.equal(result, null);
  });

  it('emits nothing when DB does not exist', () => {
    if (existsSync(DB_PATH)) rmSync(DB_PATH);
    const result = runHookWith('use mocks in tests');
    assert.equal(result, null);
  });
});
