-- 0001_indices.sql
-- Track 0B: add B-tree indices for notes(mtime), notes(tags), notes(session_id).
--
-- notes(path) skipped: UNIQUE constraint already creates sqlite_autoindex_notes_1.
--
-- notes(tags) is a B-tree; it accelerates IS NOT NULL and equality checks only.
-- It does NOT accelerate LIKE '%foo%' substring search; use notes_fts (FTS5) for that.

BEGIN IMMEDIATE;

CREATE INDEX IF NOT EXISTS idx_notes_mtime      ON notes(mtime);
CREATE INDEX IF NOT EXISTS idx_notes_tags       ON notes(tags);
CREATE INDEX IF NOT EXISTS idx_notes_session_id ON notes(session_id);

COMMIT;

-- ROLLBACK (manual — run against the DB to undo this migration):
--   DROP INDEX IF EXISTS idx_notes_mtime;
--   DROP INDEX IF EXISTS idx_notes_tags;
--   DROP INDEX IF EXISTS idx_notes_session_id;
--   DELETE FROM _migrations WHERE version = 1;
--   UPDATE meta SET value = '4' WHERE key = 'schema_version';
