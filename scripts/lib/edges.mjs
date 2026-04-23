import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, constants as fsConstants } from 'fs';
import { dirname } from 'path';
import { initSQL } from './sqljs.mjs';

let lockFd = null;

export function acquireLock(dbPath, retries = 3, delayMs = 50) {
  const lockPath = dbPath + '.lock';
  for (let i = 0; i < retries; i++) {
    try {
      lockFd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
      return true;
    } catch {
      if (i < retries - 1) {
        const start = Date.now();
        while (Date.now() - start < delayMs) {}
      }
    }
  }
  return false;
}

export function releaseLock(dbPath) {
  const lockPath = dbPath + '.lock';
  if (lockFd !== null) {
    try { closeSync(lockFd); } catch {}
    lockFd = null;
  }
  try { unlinkSync(lockPath); } catch {}
}

const VALID_TYPES = [
  'evidence_for', 'supports',
  'challenges_undermining', 'challenges_undercutting', 'challenges_rebuttal',
  'derived_from', 'associative',
];

const VALID_CONFIDENCE = ['high', 'medium', 'low'];

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
  const colsResult = db.exec('PRAGMA table_info(edges)');
  const cols = colsResult[0] ? colsResult[0].values.map(r => r[1]) : [];
  if (!cols.includes('direction_flipped')) {
    db.run('ALTER TABLE edges ADD COLUMN direction_flipped INTEGER NOT NULL DEFAULT 0');
  }
  return db;
}

// source_graph value space:
//   'local'    — edge inferred from a write/edit on this machine (default)
//   'archived' — edge preserved across an archive flow; removeOutgoingEdges skips these
//   <peer-id>  — edge originating from a peer envelope (federation, future use)
export function addEdge(db, { fromPath, toPath, edgeType, confidence = 'high', sourceGraph = 'local', directionFlipped = 0 }) {
  if (!VALID_TYPES.includes(edgeType)) {
    throw new Error(`Invalid edge type: ${edgeType}. Must be one of: ${VALID_TYPES.join(', ')}`);
  }
  if (!VALID_CONFIDENCE.includes(confidence)) {
    throw new Error(`Invalid confidence: ${confidence}. Must be one of: ${VALID_CONFIDENCE.join(', ')}`);
  }
  db.run(
    'INSERT INTO edges (from_path, to_path, edge_type, confidence, source_graph, direction_flipped) VALUES (?, ?, ?, ?, ?, ?)',
    [fromPath, toPath, edgeType, confidence, sourceGraph, directionFlipped ? 1 : 0],
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

function rowsToObjects(result) {
  if (!result || result.length === 0) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
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
      FROM edges WHERE from_path = ? AND source_graph != 'archived'
      UNION
      SELECT e.id, e.from_path, e.to_path, e.edge_type, e.confidence, e.source_graph, e.direction_flipped, e.created_at, d.depth + 1
      FROM edges e
      JOIN downstream d ON e.from_path = d.to_path
      WHERE d.depth < ? AND e.source_graph != 'archived'
    )
    SELECT DISTINCT * FROM downstream ORDER BY depth, to_path
  `;
  return rowsToObjects(db.exec(sql, [notePath, maxDepth]));
}

export function getSoleJustificationDependents(db, notePath) {
  const sql = `
    SELECT e.id, e.from_path, e.to_path, e.edge_type, e.confidence, e.source_graph, e.direction_flipped, e.created_at
    FROM edges e
    WHERE e.from_path = ?
      AND e.edge_type IN ('evidence_for', 'supports')
      AND NOT EXISTS (
        SELECT 1 FROM edges other
        WHERE other.to_path = e.to_path
          AND other.edge_type IN ('evidence_for', 'supports')
          AND other.from_path != ?
      )
  `;
  return rowsToObjects(db.exec(sql, [notePath, notePath]));
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
      WHERE r.depth < ? AND e.source_graph != 'archived'
    )
    SELECT node, MIN(depth) AS depth
    FROM reachable
    WHERE node != ?
    GROUP BY node
    ORDER BY depth, node
  `;
  return rowsToObjects(db.exec(sql, [notePath, maxDepth, notePath]));
}

// Unlike getDownstreamSymmetric, this function INCLUDES archived edges.
// Sole-dependent analysis for rewrite/correction impact maps must consider
// historical justifications — an archived note may still have sole-dependent
// relationships worth preserving in the impact map.
export function getSoleJustificationDependentsSymmetric(db, notePath) {
  const sql = `
    SELECT e.id, e.from_path, e.to_path, e.edge_type, e.confidence, e.source_graph, e.direction_flipped, e.created_at
    FROM edges e
    WHERE e.from_path = ?
      AND e.edge_type IN ('evidence_for', 'supports')
      AND NOT EXISTS (
        SELECT 1 FROM edges other
        WHERE other.to_path = e.to_path
          AND other.from_path != e.from_path
          AND other.edge_type IN ('evidence_for', 'supports')
      )
    UNION
    SELECT e.id, e.from_path, e.to_path, e.edge_type, e.confidence, e.source_graph, e.direction_flipped, e.created_at
    FROM edges e
    WHERE e.to_path = ?
      AND e.edge_type IN ('evidence_for', 'supports')
      AND NOT EXISTS (
        SELECT 1 FROM edges other
        WHERE other.to_path = e.to_path
          AND other.from_path != e.from_path
          AND other.edge_type IN ('evidence_for', 'supports')
      )
  `;
  return rowsToObjects(db.exec(sql, [notePath, notePath]));
}

export function getPendingReview(db) {
  return rowsToObjects(db.exec("SELECT * FROM edges WHERE confidence = 'medium'"));
}

export function confirmEdge(db, id, newType) {
  if (newType) {
    if (!VALID_TYPES.includes(newType)) {
      throw new Error(`Invalid edge type: ${newType}. Must be one of: ${VALID_TYPES.join(', ')}`);
    }
    db.run("UPDATE edges SET confidence = 'high', edge_type = ? WHERE id = ? AND confidence = 'medium'", [newType, id]);
  } else {
    db.run("UPDATE edges SET confidence = 'high' WHERE id = ? AND confidence = 'medium'", [id]);
  }
}

export function rejectEdge(db, id) {
  db.run("DELETE FROM edges WHERE id = ? AND confidence = 'medium'", [id]);
}

export function addSupersession(db, { oldPatternQuery, replacementNotePath = null, reason = null, supersededDate = null }) {
  if (!oldPatternQuery || !oldPatternQuery.trim()) {
    throw new Error('oldPatternQuery is required');
  }
  if (tokenize(oldPatternQuery).length === 0) {
    throw new Error(`oldPatternQuery has no content words after stopword removal: "${oldPatternQuery}". Add at least one distinctive word.`);
  }
  if (supersededDate) {
    db.run(
      'INSERT INTO supersessions (old_pattern_query, superseded_date, replacement_note_path, reason) VALUES (?, ?, ?, ?)',
      [oldPatternQuery, supersededDate, replacementNotePath, reason],
    );
  } else {
    db.run(
      'INSERT INTO supersessions (old_pattern_query, replacement_note_path, reason) VALUES (?, ?, ?)',
      [oldPatternQuery, replacementNotePath, reason],
    );
  }
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
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'have', 'has', 'had', 'i', 'you', 'we', 'they',
  'should', 'would', 'could', 'will', 'shall', 'may', 'might', 'can',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as',
  'and', 'or', 'but', 'not', 'no', 'so', 'if', 'than', 'then', 'when',
  'how', 'what', 'why', 'which', 'where', 'who', 'whose', 'whom',
  'me', 'my', 'mine', 'your', 'yours', 'our', 'ours', 'their', 'theirs',
  'this', 'that', 'these', 'those', 'it', 'its',
]);

function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t && !STOPWORDS.has(t));
}

export function findMatchingSupersessions(db, query) {
  if (!query || !query.trim()) return [];
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return [];

  const all = rowsToObjects(db.exec('SELECT * FROM supersessions'));
  const matches = [];
  for (const s of all) {
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

export function saveDb(db, dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const data = db.export();
  writeFileSync(dbPath, Buffer.from(data));
}
