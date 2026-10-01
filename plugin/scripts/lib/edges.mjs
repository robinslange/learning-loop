import { readFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { dirname } from 'path';
import { initSQL } from './sqljs.mjs';
import { logError } from './log.mjs';
import { writeFileAtomic } from './write-atomic.mjs';

const VALID_TYPES = [
  'evidence_for',
  'supports',
  'challenges_undermining',
  'challenges_undercutting',
  'challenges_rebuttal',
  'derived_from',
  'associative',
];

const VALID_CONFIDENCE = ['high', 'low'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'high',
  source_graph TEXT DEFAULT 'local',
  direction_flipped INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_path);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_path);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_confidence ON edges(confidence);
CREATE INDEX IF NOT EXISTS idx_edges_source_graph ON edges(source_graph);

CREATE TABLE IF NOT EXISTS supersessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  old_pattern_query TEXT NOT NULL,
  superseded_date TEXT NOT NULL DEFAULT (date('now')),
  replacement_note_path TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_super_pattern ON supersessions(old_pattern_query);
`;

export async function openEdgeDb(dbPath) {
  const SQL = await initSQL();
  let db;
  if (existsSync(dbPath)) {
    const buffer = readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new SQL.Database();
  }
  db.run(SCHEMA);
  // Schema migrations: detect via PRAGMA table_info rather than catching
  // SQLite error strings (error wording is engine-version specific).
  const colsResult = db.exec('PRAGMA table_info(edges)');
  const cols = colsResult[0] ? colsResult[0].values.map((r) => r[1]) : [];
  if (!cols.includes('direction_flipped')) {
    db.run('ALTER TABLE edges ADD COLUMN direction_flipped INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.includes('confidence_score')) {
    db.run('ALTER TABLE edges ADD COLUMN confidence_score REAL');
  }
  // A 'medium' row comes from an older classifier with a second, weaker verb
  // tier that nothing ever reviewed. The row keeps no record of its verb, so
  // it maps by type. Undermining and rebuttal rows become 'high': most are
  // counterpoints ("challenges", "counters", "counterpoint"), though a few were
  // "tension with" or "questions whether", which today's classifier leaves
  // unclassified; those settle when their note is next written. The rest
  // become one associative edge per (from, to) pair, and none where the pair
  // already has another edge. An archived row stays archived, and is only
  // compared with archived rows: a retired note's history must not stand in
  // for the pair's live edge.
  db.run(`
    UPDATE edges SET confidence = 'high'
    WHERE confidence = 'medium' AND edge_type IN ('challenges_undermining', 'challenges_rebuttal')
  `);
  db.run(`
    DELETE FROM edges WHERE confidence = 'medium' AND EXISTS (
      SELECT 1 FROM edges other
      WHERE other.from_path = edges.from_path AND other.to_path = edges.to_path
        AND (other.source_graph = 'archived') = (edges.source_graph = 'archived')
        AND (other.confidence != 'medium' OR other.id < edges.id)
    )
  `);
  db.run(`
    UPDATE edges
    SET edge_type = 'associative', confidence = 'low', direction_flipped = 0,
      source_graph = CASE source_graph WHEN 'archived' THEN 'archived' ELSE 'comention' END
    WHERE confidence = 'medium'
  `);
  return db;
}

// source_graph value space:
//   'local'    — edge inferred from a write/edit on this machine (default)
//   'archived' — edge preserved across an archive flow; removeOutgoingEdges skips these
//   'nli'      — legacy: written by the removed NLI contradiction subsystem. Still
//                excluded from traversal queries so pre-cleanup DBs behave; deleted
//                by scripts/nli-cleanup.mjs
//   'comention' — low-confidence associative edge from a resolved wikilink with no
//                argumentative verb nearby (edge-classifier co-mention tier). Gives
//                the graph breadth for ranking; excluded from impact traversal so
//                justification analysis stays on argued edges
//   <peer-id>  — edge originating from a peer envelope (federation, future use)
export function addEdge(
  db,
  {
    fromPath,
    toPath,
    edgeType,
    confidence = 'high',
    sourceGraph = 'local',
    directionFlipped = 0,
    confidenceScore = null,
  },
) {
  if (!VALID_TYPES.includes(edgeType)) {
    throw new Error(`Invalid edge type: ${edgeType}. Must be one of: ${VALID_TYPES.join(', ')}`);
  }
  if (!VALID_CONFIDENCE.includes(confidence)) {
    throw new Error(
      `Invalid confidence: ${confidence}. Must be one of: ${VALID_CONFIDENCE.join(', ')}`,
    );
  }
  db.run(
    'INSERT INTO edges (from_path, to_path, edge_type, confidence, source_graph, direction_flipped, confidence_score) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      fromPath,
      toPath,
      edgeType,
      confidence,
      sourceGraph,
      directionFlipped ? 1 : 0,
      confidenceScore,
    ],
  );
  const [row] = db.exec('SELECT last_insert_rowid() as id');
  return row.values[0][0];
}

export function removeEdge(db, id) {
  db.run('DELETE FROM edges WHERE id = ?', [id]);
}

export function removeEdgesByNote(db, notePath) {
  db.run('DELETE FROM edges WHERE from_path = ? OR to_path = ?', [notePath, notePath]);
}

export function removeOutgoingEdges(db, notePath) {
  db.run("DELETE FROM edges WHERE from_path = ? AND source_graph != 'archived'", [notePath]);
}

// The edges a traversal follows: argued local ones. 'archived' rows are a
// retired note's history, 'comention' rows are breadth for ranking, and 'nli'
// rows are left over from the removed contradiction detector. Takes the
// table alias, because most queries join edges to itself or to a CTE with the
// same columns.
const traversable = (t) => `${t}.source_graph NOT IN ('archived', 'nli', 'comention')`;

// Marks a note's outgoing edges source_graph='archived' rather than deleting
// them: a supersedeNoteFile-driven retirement leaves the note in place, so
// its edges should stop counting in the traversals (getDownstream and the
// symmetric walk exclude 'archived') without losing the history the
// sole-justification queries still trace. Only traversable rows are
// relabelled: an already-archived, advisory or breadth-only edge stays what
// it is.
export function archiveOutgoingEdges(db, notePath) {
  db.run(
    `UPDATE edges SET source_graph = 'archived' WHERE from_path = ? AND ${traversable('edges')}`,
    [notePath],
  );
}

function rowsToObjects(result) {
  if (!result || result.length === 0) return [];
  const { columns, values } = result[0];
  return values.map((row) => {
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

export function getEdgesFrom(db, notePath) {
  return rowsToObjects(db.exec('SELECT * FROM edges WHERE from_path = ?', [notePath]));
}

export function getEdgesTo(db, notePath) {
  return rowsToObjects(db.exec('SELECT * FROM edges WHERE to_path = ?', [notePath]));
}

export function getDownstream(db, notePath, maxDepth = 10) {
  const sql = `
    WITH RECURSIVE downstream(id, from_path, to_path, edge_type, confidence, source_graph, direction_flipped, created_at, depth) AS (
      SELECT id, from_path, to_path, edge_type, confidence, source_graph, direction_flipped, created_at, 1
      FROM edges root WHERE from_path = ? AND ${traversable('root')}
      UNION
      SELECT e.id, e.from_path, e.to_path, e.edge_type, e.confidence, e.source_graph, e.direction_flipped, e.created_at, d.depth + 1
      FROM edges e
      JOIN downstream d ON e.from_path = d.to_path
      WHERE d.depth < ? AND ${traversable('e')}
    )
    SELECT DISTINCT * FROM downstream ORDER BY depth, to_path
  `;
  return rowsToObjects(db.exec(sql, [notePath, maxDepth]));
}

// A justifying edge whose target no other note justifies. `rootMatch` picks
// which of the root's edges are candidates: its outgoing ones, or for the
// symmetric form its incoming ones too. Unlike the traversals, archived edges
// count: impact maps for a rewrite or correction must still see a retired
// note's justifications. Legacy nli rows never count as justification.
function soleJustificationDependents(db, notePath, rootMatch) {
  const sql = `
    SELECT e.id, e.from_path, e.to_path, e.edge_type, e.confidence, e.source_graph, e.direction_flipped, e.created_at
    FROM edges e
    WHERE ${rootMatch}
      AND e.edge_type IN ('evidence_for', 'supports')
      AND e.source_graph != 'nli'
      AND NOT EXISTS (
        SELECT 1 FROM edges other
        WHERE other.to_path = e.to_path
          AND other.from_path != e.from_path
          AND other.edge_type IN ('evidence_for', 'supports')
          AND other.source_graph != 'nli'
      )
  `;
  return rowsToObjects(db.exec(sql, [notePath]));
}

export function getSoleJustificationDependents(db, notePath) {
  return soleJustificationDependents(db, notePath, 'e.from_path = ?');
}

export function getSoleJustificationDependentsSymmetric(db, notePath) {
  return soleJustificationDependents(db, notePath, '? IN (e.from_path, e.to_path)');
}

export function getDownstreamSymmetric(db, notePath, maxDepth = 10) {
  const sql = `
    WITH RECURSIVE reachable(node, depth) AS (
      SELECT ?, 0
      UNION
      SELECT
        CASE WHEN e.from_path = r.node THEN e.to_path ELSE e.from_path END,
        r.depth + 1
      FROM edges e
      JOIN reachable r ON (e.from_path = r.node OR e.to_path = r.node)
      WHERE r.depth < ? AND ${traversable('e')}
    )
    SELECT node, MIN(depth) AS depth
    FROM reachable
    WHERE node != ?
    GROUP BY node
    ORDER BY depth, node
  `;
  return rowsToObjects(db.exec(sql, [notePath, maxDepth, notePath]));
}

// Edge rows shaped for cycle-detect (camelCase from/to/type plus id). Same
// eligibility filter as the recursive traversals: argued local edges only.
export function getContradictionGraphEdges(db) {
  const rows = rowsToObjects(
    db.exec(`SELECT id, from_path, to_path, edge_type FROM edges e WHERE ${traversable('e')}`),
  );
  return rows.map((r) => ({
    id: r.id,
    fromPath: r.from_path,
    toPath: r.to_path,
    edgeType: r.edge_type,
  }));
}

export function addSupersession(
  db,
  { oldPatternQuery, replacementNotePath = null, reason = null, supersededDate = null },
) {
  if (!oldPatternQuery || !oldPatternQuery.trim()) {
    throw new Error('oldPatternQuery is required');
  }
  if (tokenize(oldPatternQuery).length === 0) {
    throw new Error(
      `oldPatternQuery has no content words after stopword removal: "${oldPatternQuery}". Add at least one distinctive word.`,
    );
  }
  db.run(
    "INSERT INTO supersessions (old_pattern_query, superseded_date, replacement_note_path, reason) VALUES (?, COALESCE(NULLIF(?, ''), date('now')), ?, ?)",
    [oldPatternQuery, supersededDate, replacementNotePath, reason],
  );
  const [row] = db.exec('SELECT last_insert_rowid() as id');
  return row.values[0][0];
}

export function removeSupersession(db, id) {
  db.run('DELETE FROM supersessions WHERE id = ?', [id]);
}

export function listSupersessions(db) {
  return rowsToObjects(db.exec('SELECT * FROM supersessions ORDER BY superseded_date DESC'));
}

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'have',
  'has',
  'had',
  'i',
  'you',
  'we',
  'they',
  'should',
  'would',
  'could',
  'will',
  'shall',
  'may',
  'might',
  'can',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'as',
  'and',
  'or',
  'but',
  'not',
  'no',
  'so',
  'if',
  'than',
  'then',
  'when',
  'how',
  'what',
  'why',
  'which',
  'where',
  'who',
  'whose',
  'whom',
  'me',
  'my',
  'mine',
  'your',
  'yours',
  'our',
  'ours',
  'their',
  'theirs',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t));
}

// Pure matcher over already-loaded supersession rows. The SQL layer only ever
// feeds it SELECT *; hot-path callers (post-search-tracking) match against
// the JSON sidecar instead and never boot sql.js.
export function matchSupersessions(rows, query) {
  if (!query || !query.trim()) return [];
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return [];

  const matches = [];
  for (const s of rows) {
    const patternTokens = new Set(tokenize(s.old_pattern_query || ''));
    if (patternTokens.size === 0) continue;
    let shared = 0;
    for (const t of patternTokens) {
      if (queryTokens.has(t)) shared++;
    }
    const ratio = shared / patternTokens.size;
    const minShared = patternTokens.size === 1 ? 1 : 2;
    if (shared >= minShared && ratio >= 0.5) {
      matches.push({ ...s, match_ratio: ratio });
    }
  }
  return matches.sort((a, b) => b.match_ratio - a.match_ratio);
}

export function findMatchingSupersessions(db, query) {
  return matchSupersessions(rowsToObjects(db.exec('SELECT * FROM supersessions')), query);
}

// Read the supersessions table without booting sql.js when possible. Keeps an
// mtime-keyed JSON sidecar next to edges.db: valid (sidecar newer than db)
// means two stats + a tiny JSON parse; stale or missing means one cold
// openEdgeDb rebuild, after which every call is cheap until edges.db changes.
// The common case, an instance with zero supersessions, settles to parsing
// "[]" per call instead of a WASM compile + full 1MB+ db read.
export async function loadSupersessionsCached(dbPath) {
  if (!existsSync(dbPath)) return [];
  const sidecar = `${dbPath}.supersessions.json`;
  try {
    const dbMtime = statSync(dbPath).mtimeMs;
    if (statSync(sidecar).mtimeMs >= dbMtime) {
      const rows = JSON.parse(readFileSync(sidecar, 'utf8'));
      if (Array.isArray(rows)) return rows;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') logError('edges.loadSupersessionsCached.read', err);
  }
  let db;
  try {
    db = await openEdgeDb(dbPath);
    const rows = rowsToObjects(db.exec('SELECT * FROM supersessions'));
    try {
      writeFileAtomic(sidecar, JSON.stringify(rows));
    } catch (err) {
      logError('edges.loadSupersessionsCached.write', err);
    }
    return rows;
  } finally {
    if (db) db.close();
  }
}

export function saveDb(db, dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const data = db.export();
  // Full-image rewrite on every vault write: a crash mid-write must not
  // corrupt the whole justification graph. Write-then-rename is atomic on
  // the same filesystem.
  writeFileAtomic(dbPath, Buffer.from(data));
}
