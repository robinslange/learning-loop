import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openEdgeDb, getEdgesFrom, getEdgesTo, getPendingReview, addEdge, saveDb } from '../scripts/lib/edges.mjs';

const HOOK = join(import.meta.dirname, '..', 'hooks', 'post-write-edge-infer.js');
const VAULT = '/tmp/ll-test-vault-edge-infer';
const PLUGIN_DATA = '/tmp/ll-test-plugin-data-edge-infer';
const DB_PATH = join(PLUGIN_DATA, 'edges.db');

function run(toolName, filePath, content, success = true) {
  const input = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: { file_path: filePath, content },
    tool_response: { filePath, success },
  });
  execFileSync('node', [HOOK], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, VAULT_PATH: VAULT, CLAUDE_PLUGIN_DATA: PLUGIN_DATA },
    timeout: 8000,
  });
}

async function readEdges(notePath) {
  const db = await openEdgeDb(DB_PATH);
  try {
    return getEdgesFrom(db, notePath);
  } finally {
    db.close();
  }
}

async function readPending() {
  const db = await openEdgeDb(DB_PATH);
  try {
    return getPendingReview(db);
  } finally {
    db.close();
  }
}

describe('post-write-edge-infer', () => {
  before(() => {
    mkdirSync(join(VAULT, '3-permanent'), { recursive: true });
    mkdirSync(PLUGIN_DATA, { recursive: true });
  });

  beforeEach(() => {
    if (existsSync(DB_PATH)) rmSync(DB_PATH);
  });

  after(() => {
    rmSync(VAULT, { recursive: true, force: true });
    rmSync(PLUGIN_DATA, { recursive: true, force: true });
  });

  function stub(name) {
    writeFileSync(join(VAULT, '3-permanent', `${name}.md`), `# ${name}\n`);
  }

  it('classifies high-confidence evidence_for from "proves"', async () => {
    stub('target-claim');
    const content = '---\ntags: [test]\n---\n# Note\n\nThis result proves [[target-claim]] holds in practice.\n';
    run('Write', join(VAULT, '3-permanent', 'source-a.md'), content);
    const edges = await readEdges('3-permanent/source-a.md');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].edge_type, 'evidence_for');
    assert.equal(edges[0].confidence, 'high');
    assert.equal(edges[0].to_path, '3-permanent/target-claim.md');
  });

  it('classifies high-confidence challenges_undermining from "contradicts"', async () => {
    stub('old-belief');
    const content = '---\ntags: [test]\n---\n# Note\n\nThe new data contradicts [[old-belief]] entirely.\n';
    run('Write', join(VAULT, '3-permanent', 'source-b.md'), content);
    const edges = await readEdges('3-permanent/source-b.md');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].edge_type, 'challenges_undermining');
    assert.equal(edges[0].confidence, 'high');
  });

  it('classifies derived_from from "builds on"', async () => {
    stub('parent-idea');
    const content = '---\ntags: [test]\n---\n# Note\n\nThis builds on [[parent-idea]] with new examples.\n';
    run('Write', join(VAULT, '3-permanent', 'source-c.md'), content);
    const edges = await readEdges('3-permanent/source-c.md');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].edge_type, 'derived_from');
    assert.equal(edges[0].confidence, 'high');
  });

  it('queues medium-confidence edges for review', async () => {
    stub('fusion-method');
    const content = '---\ntags: [test]\n---\n# Note\n\nThis aligns with [[fusion-method]] in spirit.\n';
    run('Write', join(VAULT, '3-permanent', 'source-d.md'), content);
    const pending = await readPending();
    assert.ok(pending.length >= 1);
    const ours = pending.find(e => e.from_path === '3-permanent/source-d.md');
    assert.ok(ours);
    assert.equal(ours.confidence, 'medium');
    assert.equal(ours.edge_type, 'supports');
  });

  it('skips associative links with no signal', async () => {
    stub('bare-link');
    const content = '---\ntags: [test]\n---\n# Note\n\nSome content.\n\n[[bare-link]]\n';
    run('Write', join(VAULT, '3-permanent', 'source-e.md'), content);
    const edges = await readEdges('3-permanent/source-e.md');
    assert.equal(edges.length, 0);
  });

  it('is idempotent: re-running replaces old edges', async () => {
    stub('claim');
    const content = '---\ntags: [test]\n---\n# Note\n\nThis proves [[claim]] outright.\n';
    const path = join(VAULT, '3-permanent', 'source-f.md');
    run('Write', path, content);
    run('Write', path, content);
    run('Write', path, content);
    const edges = await readEdges('3-permanent/source-f.md');
    assert.equal(edges.length, 1);
  });

  it('replaces stale edges when content changes', async () => {
    stub('old-claim');
    stub('new-claim');
    const path = join(VAULT, '3-permanent', 'source-g.md');
    run('Write', path, '# Note\n\nThis proves [[old-claim]].\n');
    run('Write', path, '# Note\n\nThis proves [[new-claim]].\n');
    const edges = await readEdges('3-permanent/source-g.md');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].to_path, '3-permanent/new-claim.md');
  });

  it('skips unresolvable links (broken wikilinks)', async () => {
    const content = '---\ntags: [test]\n---\n# Note\n\nThis proves [[nonexistent-target]] holds.\n';
    run('Write', join(VAULT, '3-permanent', 'source-broken.md'), content);
    const edges = await readEdges('3-permanent/source-broken.md');
    assert.equal(edges.length, 0);
  });

  it('ignores non-vault writes', async () => {
    const content = '# Note\n\nThis proves [[anything]].\n';
    run('Write', '/tmp/somewhere-else/note.md', content);
    if (existsSync(DB_PATH)) {
      const db = await openEdgeDb(DB_PATH);
      const all = db.exec('SELECT COUNT(*) FROM edges');
      const count = all.length ? all[0].values[0][0] : 0;
      db.close();
      assert.equal(count, 0);
    }
  });

  it('ignores failed writes', async () => {
    const content = '# Note\n\nThis proves [[x]].\n';
    run('Write', join(VAULT, '3-permanent', 'failed.md'), content, false);
    if (existsSync(DB_PATH)) {
      const edges = await readEdges('3-permanent/failed.md');
      assert.equal(edges.length, 0);
    }
  });

  it('skips self-links', async () => {
    const content = '# Note\n\nThis proves [[self-link]] which is myself.\n';
    run('Write', join(VAULT, '3-permanent', 'self-link.md'), content);
    const edges = await readEdges('3-permanent/self-link.md');
    assert.equal(edges.length, 0);
  });

  it('stores resolved vault paths in to_path so multi-hop traversal works', async () => {
    writeFileSync(join(VAULT, '3-permanent', 'note-a.md'), '# A\n\n');
    writeFileSync(join(VAULT, '3-permanent', 'note-b.md'), '# B\n\nThis proves [[note-a]] holds.\n');
    writeFileSync(join(VAULT, '3-permanent', 'note-c.md'), '# C\n\nThis proves [[note-b]] holds.\n');

    run('Write', join(VAULT, '3-permanent', 'note-b.md'), '# B\n\nThis proves [[note-a]] holds.\n');
    run('Write', join(VAULT, '3-permanent', 'note-c.md'), '# C\n\nThis proves [[note-b]] holds.\n');

    const db = await openEdgeDb(DB_PATH);
    const fromB = getEdgesFrom(db, '3-permanent/note-b.md');
    assert.equal(fromB.length, 1);
    assert.equal(fromB[0].to_path, '3-permanent/note-a.md', 'to_path must be a full vault-relative path');

    const downstream = db.exec(`
      WITH RECURSIVE downstream(from_path, to_path, depth) AS (
        SELECT from_path, to_path, 1 FROM edges WHERE from_path = '3-permanent/note-c.md'
        UNION
        SELECT e.from_path, e.to_path, d.depth + 1 FROM edges e JOIN downstream d ON e.from_path = d.to_path WHERE d.depth < 5
      )
      SELECT DISTINCT to_path, depth FROM downstream ORDER BY depth
    `);
    db.close();

    const rows = downstream[0]?.values || [];
    assert.deepEqual(rows, [
      ['3-permanent/note-b.md', 1],
      ['3-permanent/note-a.md', 2],
    ], 'recursive CTE must traverse C → B → A across two hops');
  });

  it('preserves incoming edges when re-running', async () => {
    stub('downstream-claim');
    const targetRel = '3-permanent/target.md';
    const db = await openEdgeDb(DB_PATH);
    addEdge(db, { fromPath: '3-permanent/some-other-note.md', toPath: targetRel, edgeType: 'evidence_for' });
    saveDb(db, DB_PATH);
    db.close();

    const content = '# Target\n\nThis proves [[downstream-claim]].\n';
    run('Write', join(VAULT, '3-permanent', 'target.md'), content);

    const db2 = await openEdgeDb(DB_PATH);
    const incoming = getEdgesTo(db2, targetRel);
    db2.close();
    assert.equal(incoming.length, 1, 'incoming edge from other note must survive');
    assert.equal(incoming[0].from_path, '3-permanent/some-other-note.md');
  });

  it('handles notes with no wikilinks', async () => {
    const content = '---\ntags: [test]\n---\nNo links at all.\n';
    assert.doesNotThrow(() => {
      run('Write', join(VAULT, '3-permanent', 'no-links.md'), content);
    });
  });

  it('writes high-confidence edges to frontmatter', () => {
    stub('claim-a');
    const path = join(VAULT, '3-permanent', 'sync-a.md');
    const content = '---\ntags: [test]\n---\n# Note\n\nThis proves [[claim-a]].\n';
    writeFileSync(path, content);
    run('Write', path, content);
    const after = readFileSync(path, 'utf-8');
    assert.match(after, /evidence-for:\s*\["?\[\[claim-a\]\]"?\]/);
    assert.match(after, /tags:\s*\[test\]/);
  });

  it('skips frontmatter sync for medium-confidence edges', () => {
    stub('soft-claim');
    const path = join(VAULT, '3-permanent', 'sync-b.md');
    const content = '---\ntags: [test]\n---\n# Note\n\nThis aligns with [[soft-claim]].\n';
    writeFileSync(path, content);
    run('Write', path, content);
    const after = readFileSync(path, 'utf-8');
    assert.doesNotMatch(after, /supports:/);
  });

  it('merges new high-confidence edges with existing frontmatter array', () => {
    stub('old-claim');
    stub('new-claim');
    const path = join(VAULT, '3-permanent', 'sync-c.md');
    const content = '---\ntags: [test]\nevidence-for: ["[[old-claim]]"]\n---\n# Note\n\nThis proves [[new-claim]].\n';
    writeFileSync(path, content);
    run('Write', path, content);
    const after = readFileSync(path, 'utf-8');
    assert.match(after, /\[\[old-claim\]\]/);
    assert.match(after, /\[\[new-claim\]\]/);
  });

  it('does not duplicate links already in frontmatter', () => {
    stub('the-claim');
    const path = join(VAULT, '3-permanent', 'sync-d.md');
    const content = '---\ntags: [test]\nevidence-for: ["[[the-claim]]"]\n---\n# Note\n\nThis proves [[the-claim]].\n';
    writeFileSync(path, content);
    run('Write', path, content);
    const after = readFileSync(path, 'utf-8');
    const fmMatch = after.match(/^---\n([\s\S]*?)\n---/);
    const fmBody = fmMatch[1];
    const fmMatches = fmBody.match(/\[\[the-claim\]\]/g);
    assert.equal(fmMatches.length, 1, 'frontmatter array must not duplicate the claim');
  });

  it('creates frontmatter when note has none', () => {
    stub('claim-x');
    const path = join(VAULT, '3-permanent', 'no-fm.md');
    const content = '# Note\n\nThis proves [[claim-x]].\n';
    writeFileSync(path, content);
    run('Write', path, content);
    const after = readFileSync(path, 'utf-8');
    assert.match(after, /^---\n/);
    assert.match(after, /evidence-for:\s*\["?\[\[claim-x\]\]"?\]/);
    assert.match(after, /# Note/);
  });

  it('upgrades block-format frontmatter arrays to inline', () => {
    stub('old-claim');
    stub('new-claim');
    const path = join(VAULT, '3-permanent', 'block-fm.md');
    const content = '---\ntags: [test]\nevidence-for:\n  - "[[old-claim]]"\n---\n# Note\n\nThis proves [[new-claim]].\n';
    writeFileSync(path, content);
    run('Write', path, content);
    const after = readFileSync(path, 'utf-8');
    assert.match(after, /evidence-for:\s*\[.*\[\[old-claim\]\].*\[\[new-claim\]\].*\]/);
    assert.doesNotMatch(after, /evidence-for:\s*\n\s*-/);
  });

  it('appends evidence-for key when frontmatter exists but key is absent', () => {
    stub('target-y');
    const path = join(VAULT, '3-permanent', 'fm-no-key.md');
    const content = '---\ntags: [test]\n---\n# Note\n\nThis proves [[target-y]].\n';
    writeFileSync(path, content);
    run('Write', path, content);
    const after = readFileSync(path, 'utf-8');
    assert.match(after, /evidence-for:\s*\["?\[\[target-y\]\]"?\]/);
  });
});
