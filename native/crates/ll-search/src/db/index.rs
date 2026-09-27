use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::config::EMBED_BATCH_SIZE;
use crate::embed::embed_documents;
use crate::preprocess::{content_hash_parts, preprocess_file, Intention};

use super::query::{chrono_iso_now, compute_project_phases, compute_sessions};
use super::schema::{create_schema, drop_all};

#[derive(Debug, Clone)]
pub struct WalkEntry {
    pub rel_path: String,
    pub full_path: String,
    pub mtime: f64,
}

#[derive(Serialize)]
pub struct IndexResult {
    pub embedded: usize,
    pub deleted: usize,
    pub total: usize,
    /// `(rel_path, colliding_id)` for every note reassigned a new id because
    /// another note already claimed its `id:`.
    pub duplicate_ids: Vec<(String, String)>,
    /// `(rel_path, reason)` for every note left without a stable id because it
    /// could not be read or the frontmatter guard refused the rewrite.
    pub refused_ids: Vec<(String, String)>,
}

/// One fully-preprocessed note ready for database insertion.
pub struct EmbedItem {
    pub path: String,
    pub note_uuid: Option<String>,
    pub title: String,
    pub tags: String,
    pub body: String,
    pub text: String,
    pub hash: String,
    pub mtime: f64,
    pub links: Vec<String>,
    pub intentions: Vec<Intention>,
}

/// SQL for the three FTS content-sync triggers managed by schema.rs.
///
/// We temporarily drop these triggers during batch inserts to avoid N
/// per-row FTS writes, then rebuild the FTS index once at the end and
/// recreate the triggers.  This is the dominant throughput win for large
/// batches.
const FTS_TRIGGER_AI: &str =
    "CREATE TRIGGER IF NOT EXISTS notes_content_ai AFTER INSERT ON notes_content BEGIN
        INSERT INTO notes_fts(rowid, title, tags, body)
        VALUES (new.id, new.title, new.tags, new.body);
    END;";

const FTS_TRIGGER_AD: &str =
    "CREATE TRIGGER IF NOT EXISTS notes_content_ad AFTER DELETE ON notes_content BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, tags, body)
        VALUES ('delete', old.id, old.title, old.tags, old.body);
    END;";

const FTS_TRIGGER_AU: &str =
    "CREATE TRIGGER IF NOT EXISTS notes_content_au AFTER UPDATE ON notes_content BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, tags, body)
        VALUES ('delete', old.id, old.title, old.tags, old.body);
        INSERT INTO notes_fts(rowid, title, tags, body)
        VALUES (new.id, new.title, new.tags, new.body);
    END;";

/// Write a batch of already-embedded notes into an open transaction.
///
/// **Plan B — FTS bypass + `prepare_cached` + `RETURNING id`:**
/// 1. Drop the three FTS content-sync triggers on `notes_content`.
/// 2. Run all per-note inserts with `prepare_cached`; `INSERT … RETURNING id`
///    eliminates the per-note `SELECT id` round-trip.
/// 3. Rebuild the FTS index once via `INSERT INTO notes_fts(notes_fts) VALUES('rebuild')`.
/// 4. Recreate the three triggers.
///
/// This reduces O(N) FTS writes to one bulk rebuild, which is the dominant
/// throughput improvement for large batches (≥1k notes).
///
/// The caller is responsible for wrapping this in a transaction and
/// committing afterwards.  FTS is consistent at commit time.
///
/// Exposed as `pub` so benchmarks and integration tests can drive the write
/// path without going through the full `reindex` pipeline (including ONNX).
pub fn insert_embedded(
    conn: &Connection,
    items: &[&EmbedItem],
    vecs: &[Vec<f32>],
) -> Result<()> {
    debug_assert_eq!(items.len(), vecs.len(), "items and vecs must be 1-to-1");

    // Drop FTS triggers for the duration of this batch so each notes_content
    // write doesn't fan out to a separate FTS row operation.
    conn.execute_batch(
        "DROP TRIGGER IF EXISTS notes_content_ai;
         DROP TRIGGER IF EXISTS notes_content_ad;
         DROP TRIGGER IF EXISTS notes_content_au;",
    )?;

    for (item, vec) in items.iter().zip(vecs.iter()) {
        let note_id: i64 = conn
            .prepare_cached(
                "INSERT INTO notes (path, content_hash, mtime, title, tags, note_uuid)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(path) DO UPDATE SET
                   content_hash = excluded.content_hash,
                   mtime = excluded.mtime,
                   title = excluded.title,
                   tags = excluded.tags,
                   note_uuid = COALESCE(notes.note_uuid, excluded.note_uuid)
                 RETURNING id",
            )?
            .query_row(
                params![item.path, item.hash, item.mtime, item.title, item.tags, item.note_uuid],
                |row| row.get(0),
            )?;

        conn.prepare_cached(
            "INSERT OR REPLACE INTO notes_content (id, title, tags, body) VALUES (?1, ?2, ?3, ?4)",
        )?
        .execute(params![note_id, item.title, item.tags, item.body])?;

        conn.prepare_cached("DELETE FROM embeddings WHERE id = ?1")?
            .execute(params![note_id])?;

        let blob: Vec<u8> = vec.iter().flat_map(|f| f.to_le_bytes()).collect();
        conn.prepare_cached(
            "INSERT INTO embeddings (id, data) VALUES (?1, ?2)",
        )?
        .execute(params![note_id, blob])?;

        conn.prepare_cached("DELETE FROM links WHERE source_id = ?1")?
            .execute(params![note_id])?;
        {
            let mut link_stmt = conn.prepare_cached(
                "INSERT OR IGNORE INTO links (source_id, target_path) VALUES (?1, ?2)",
            )?;
            for target in &item.links {
                link_stmt.execute(params![note_id, target])?;
            }
        }

        conn.prepare_cached("DELETE FROM intentions WHERE note_id = ?1")?
            .execute(params![note_id])?;
        {
            let mut intent_stmt = conn.prepare_cached(
                "INSERT OR REPLACE INTO intentions (note_id, context, cue) VALUES (?1, ?2, ?3)",
            )?;
            for intent in &item.intentions {
                intent_stmt.execute(params![note_id, intent.context, intent.cue])?;
            }
        }
    }

    // Rebuild FTS from the current notes_content rows (one pass), then restore
    // the per-row triggers so incremental updates after this batch work normally.
    conn.execute_batch("INSERT INTO notes_fts(notes_fts) VALUES('rebuild');")?;
    conn.execute_batch(FTS_TRIGGER_AI)?;
    conn.execute_batch(FTS_TRIGGER_AD)?;
    conn.execute_batch(FTS_TRIGGER_AU)?;

    Ok(())
}

/// Point every row at the path its note occupies now, so a note that MOVED
/// stays the same note. Identity is `note_uuid`; `path` is an attribute of it.
///
/// Without this, a promoted note is an INSERT at its new path while the stale
/// row still holds its uuid, and `idx_notes_uuid` (UNIQUE on note_uuid WHERE
/// NOT NULL) aborts the entire reindex: "UNIQUE constraint failed:
/// notes.note_uuid". Not the file, the whole run — the deletion pass that
/// would have cleared the stale row runs after the inserts. Moving a note from
/// `0-inbox` to `3-permanent` is exactly this, and it is what every promotion
/// does. Following the id also keeps the note's embedding: a move is not a
/// content change.
///
/// `resolve_note_uuids` gives a BIJECTION — its `seen` set makes ids unique
/// across the vault, and rel_paths are unique by construction — so this is a
/// permutation of paths over rows, and `desired_paths` declares both halves of
/// that as constraints rather than trusting them.
///
/// Applying a permutation row by row is where the previous version went wrong.
/// It asked each row "is my destination free?" and skipped the move when it
/// was not. For two notes that exchange paths the answer is no for both, since
/// each destination is held by the row that is itself about to leave, so both
/// moves were refused — and the insert pass then wrote each file's content onto
/// whichever row already sat at its path, leaving two notes wearing each
/// other's `note_uuid`. That id is the address federation publishes a note
/// under, so the wrong body goes out under it. Silent, and worse in kind than
/// the abort it replaced.
///
/// So no row is asked about its destination. There is one question instead,
/// asked of every row at once: is the note that belongs at my path a DIFFERENT
/// row? Everyone for whom that is true is evicted, and then everyone sits
/// down. By the time anything lands its seat is vacant by construction, so
/// cycles of any length work and a swap is just the shortest one.
///
/// Asking it that way is also what keeps a row with no id off the eviction
/// list. A NULL `note_uuid` at a path the vault still has is almost always
/// that note with its column unfilled — the absorbing state the backfill pass
/// below exists for — and it is a ghost only when the id that owns the path
/// already has a row elsewhere. "Someone else's row belongs here" separates
/// those two; "someone else's id belongs here" does not, and evicting on it
/// strands the note outside the vault's path space where the backfill can
/// never reach it.
///
/// The parking namespace is `moving:<id>`: unique because `id` is the primary
/// key, and unreachable by any real note because `walk_vault` emits only paths
/// ending in `.md`.
///
/// A row that parks and never lands is that ghost. It stays parked, which puts
/// it outside `vault_paths`, and the deletion pass in `reindex` collects it.
///
/// WHAT THIS DOES NOT COVER: a swap between rows that are ALL still id-less.
///
/// Only the LAND half is keyed on `note_uuid`; the park half is keyed on the
/// candidate row's PATH, and asks whether the id owning that path belongs to a
/// different row. So an id-less row IS parked whenever some other row owns the
/// id its path now belongs to — the ordinary half-backfilled state — and since
/// it can never land, it stays parked, outside `vault_paths`, and the deletion
/// pass collects it. That costs its embedding and nothing else: the note's
/// `id:` is on disk, so it is re-indexed as itself. It is the SAFE outcome.
///
/// The unsafe case is narrower than "NULL rows": it needs NO row to own any of
/// the desired ids, so that nothing parks at all. Then the backfill below
/// stamps each row with the id of whatever file now sits at its path, without
/// checking the row's content is still that file's, and the result is the same
/// wrong-body-under-the-wrong-id this function exists to prevent.
///
/// It is not a regression (the previous `WHERE note_uuid = ?2` never matched
/// NULL either) and it is narrow: it needs two id-less rows, a swap, and the
/// two notes' mtimes within 1 MILLISECOND of each other, which is what
/// `(ex_mtime - file.mtime).abs() < 1.0` compares — `walk_vault` stores
/// `as_secs_f64() * 1000.0`, so the tolerance reads as seconds and is not.
/// Any re-read repairs it, because by then the row carries the backfilled id
/// and `insert_embedded`'s `COALESCE` keeps it while the content is replaced.
/// The exposed window is therefore precisely a vault's FIRST reindex after the
/// column is added, when every row is id-less at once and no row owns
/// anything.
///
/// The statement that writes the wrong id is the backfill, not this pass:
/// `UPDATE notes SET note_uuid = ?1 WHERE path = ?2 AND note_uuid IS NULL`
/// asserts "the row at path P is the note now at P", which is the assumption
/// this pass exists to stop trusting. Moving the backfill earlier does not
/// help — it stamps the same wrong id, sooner. Fixing it means either claiming
/// NULL rows by path here before the backfill runs, or the backfill refusing a
/// row whose `content_hash` does not match the file it is about to adopt, at a
/// cost of one read per id-less row. That is a change, not a comment.
fn follow_moved_notes(
    conn: &Connection,
    vault_files: &[WalkEntry],
    note_uuids: &HashMap<String, String>,
) -> Result<usize> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS desired_paths (
             note_uuid TEXT PRIMARY KEY,
             path      TEXT NOT NULL UNIQUE
         );
         DELETE FROM desired_paths;",
    )?;
    {
        let mut ins =
            tx.prepare("INSERT INTO desired_paths (note_uuid, path) VALUES (?1, ?2)")?;
        for file in vault_files {
            if let Some(uuid) = note_uuids.get(&file.rel_path) {
                ins.execute(params![uuid, file.rel_path])?;
            }
        }
    }

    tx.execute(
        "UPDATE notes SET path = 'moving:' || id
          WHERE EXISTS (SELECT 1 FROM desired_paths d
                          JOIN notes owner ON owner.note_uuid = d.note_uuid
                         WHERE d.path = notes.path
                           AND owner.id <> notes.id)",
        [],
    )?;

    let landed = tx.execute(
        "UPDATE notes
            SET path = (SELECT d.path FROM desired_paths d WHERE d.note_uuid = notes.note_uuid)
          WHERE note_uuid IN (SELECT note_uuid FROM desired_paths)
            AND path <> (SELECT d.path FROM desired_paths d
                          WHERE d.note_uuid = notes.note_uuid)",
        [],
    )?;

    tx.commit()?;
    Ok(landed)
}

pub fn reindex(conn: &Connection, vault_path: &str, force: bool) -> Result<IndexResult> {
    if force {
        eprintln!("Force rebuild: dropping all tables...");
        drop_all(conn);
        create_schema(conn);
    }

    let vault_files = walk_vault(vault_path);
    let vault_paths: HashSet<&str> = vault_files.iter().map(|f| f.rel_path.as_str()).collect();

    // Every note gets a stable id, whether or not its content changed. Doing
    // this inside the per-file loop would skip unchanged notes, so an
    // incremental index would leave most of the vault unaddressable.
    let ResolvedIds { ids: note_uuids, reassigned: duplicate_ids, refused: refused_ids } =
        resolve_note_uuids(Path::new(vault_path), &vault_files);

    let moved = follow_moved_notes(conn, &vault_files, &note_uuids)?;
    if moved > 0 {
        eprintln!("Followed {moved} note(s) to a new path by their stable id.");
    }

    // ...and every note gets it in the DATABASE too, which is where everything
    // downstream reads it. `resolve_note_uuids` writes `id:` into the file; the
    // only writer of the COLUMN was `insert_embedded`, reachable only for notes
    // that get re-embedded. So a note whose id was just written was then skipped
    // by the mtime check below and kept `note_uuid` NULL — permanently.
    //
    // The steady state is a trap rather than a delay. Run 1 writes `id:` into
    // the file, but `walk_vault` captured `file.mtime` BEFORE that write, so the
    // note is skipped. Run 2 sees the changed mtime, re-reads, and finds the
    // content hash unchanged — the hash is taken over the frontmatter-stripped
    // body, so adding an `id:` line moves none of it — and takes the
    // update-mtime branch, which writes mtime and nothing else. Run 3 onward the
    // mtimes agree and it is skipped forever.
    //
    // `export_index` selects `WHERE note_uuid IS NOT NULL`, so such a note is
    // silently absent from every sync. Measured on the vault this was found in:
    // 3 of 6,051 notes, all carrying an `id:` on disk, none of which had ever
    // been exported. The count is small only because that vault is edited
    // constantly; a mostly-static one lands its whole corpus here.
    let backfilled = {
        let tx = conn.unchecked_transaction()?;
        let mut n = 0usize;
        {
            let mut stmt = tx.prepare(
                "UPDATE notes SET note_uuid = ?1 WHERE path = ?2 AND note_uuid IS NULL",
            )?;
            for file in &vault_files {
                if let Some(uuid) = note_uuids.get(&file.rel_path) {
                    n += stmt.execute(rusqlite::params![uuid, file.rel_path])?;
                }
            }
        }
        tx.commit()?;
        n
    };
    if backfilled > 0 {
        eprintln!("Assigned a stable id to {backfilled} note(s) that had none in the index.");
    }

    let mut existing: HashMap<String, (i64, String, f64)> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, path, content_hash, mtime FROM notes")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f64>(3)?,
                ))
            })?;
        for row in rows {
            let (id, path, hash, mtime) = row?;
            existing.insert(path, (id, hash, mtime));
        }
    }

    let mut to_embed: Vec<EmbedItem> = Vec::new();
    let mut to_update_mtime: Vec<(i64, f64)> = Vec::new();
    let mut to_update_intentions: Vec<(i64, Vec<Intention>)> = Vec::new();
    let mut to_delete: Vec<i64> = Vec::new();
    let mut skipped: usize = 0;

    for file in &vault_files {
        let ex = existing.get(&file.rel_path);

        if let Some(&(_, _, ex_mtime)) = ex {
            if (ex_mtime - file.mtime).abs() < 1.0 {
                skipped += 1;
                continue;
            }
        }

        let raw = match fs::read_to_string(&file.full_path) {
            Ok(s) => s,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        let filename = Path::new(&file.rel_path)
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or(&file.rel_path);

        let result = match preprocess_file(&raw, filename) {
            Some(r) => r,
            None => {
                skipped += 1;
                continue;
            }
        };

        let hash = content_hash_parts(&result.title, &result.tags, &result.body);

        if let Some(&(id, ref ex_hash, _)) = ex {
            if *ex_hash == hash {
                to_update_mtime.push((id, file.mtime));
                to_update_intentions.push((id, result.intentions));
                continue;
            }
        }

        let note_uuid = note_uuids.get(&file.rel_path).cloned();
        to_embed.push(EmbedItem {
            note_uuid,
            path: file.rel_path.clone(),
            title: result.title,
            tags: result.tags,
            body: result.body,
            text: result.text,
            hash,
            mtime: file.mtime,
            links: result.links,
            intentions: result.intentions,
        });
    }

    for (path, &(id, _, _)) in &existing {
        if !vault_paths.contains(path.as_str()) {
            to_delete.push(id);
        }
    }

    eprintln!(
        "Index: {} to embed, {} mtime-only, {} to delete, {} unchanged",
        to_embed.len(),
        to_update_mtime.len(),
        to_delete.len(),
        skipped
    );

    let mut embedded_vecs: Vec<Vec<f32>> = Vec::with_capacity(to_embed.len());

    for batch_start in (0..to_embed.len()).step_by(EMBED_BATCH_SIZE) {
        let batch_end = (batch_start + EMBED_BATCH_SIZE).min(to_embed.len());
        let texts: Vec<String> = to_embed[batch_start..batch_end]
            .iter()
            .map(|item| item.text.clone())
            .collect();
        let vecs = embed_documents(&texts);
        embedded_vecs.extend(vecs);
        eprintln!("  Embedded {}/{}", batch_end, to_embed.len());
    }

    conn.execute_batch("BEGIN TRANSACTION;")?;

    let item_refs: Vec<&EmbedItem> = to_embed.iter().collect();
    insert_embedded(conn, &item_refs, &embedded_vecs)?;

    for &(id, mtime) in &to_update_mtime {
        conn.prepare_cached("UPDATE notes SET mtime = ?1 WHERE id = ?2")?
            .execute(params![mtime, id])?;
    }

    for (id, intentions) in &to_update_intentions {
        conn.prepare_cached("DELETE FROM intentions WHERE note_id = ?1")?
            .execute(params![id])?;
        let mut stmt = conn.prepare_cached(
            "INSERT OR REPLACE INTO intentions (note_id, context, cue) VALUES (?1, ?2, ?3)",
        )?;
        for intent in intentions {
            stmt.execute(params![id, intent.context, intent.cue])?;
        }
    }

    for &id in &to_delete {
        conn.prepare_cached("DELETE FROM embeddings WHERE id = ?1")?
            .execute(params![id])?;
        conn.prepare_cached("DELETE FROM links WHERE source_id = ?1")?
            .execute(params![id])?;
        conn.prepare_cached("DELETE FROM intentions WHERE note_id = ?1")?
            .execute(params![id])?;
        conn.prepare_cached("DELETE FROM notes_content WHERE id = ?1")?
            .execute(params![id])?;
        conn.prepare_cached("DELETE FROM notes WHERE id = ?1")?
            .execute(params![id])?;
    }

    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .unwrap_or(0);

    let now = chrono_iso_now();
    conn.prepare_cached(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
    )?
    .execute(params!["indexed_at", now])?;
    conn.prepare_cached(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
    )?
    .execute(params!["note_count", total.to_string()])?;

    conn.execute_batch("COMMIT;")?;

    let total = total as usize;
    eprintln!("Index complete: {} notes indexed", total);

    compute_sessions(conn);
    compute_project_phases(conn);

    conn.execute(
        "DELETE FROM intentions WHERE note_id NOT IN (SELECT id FROM notes)",
        [],
    )
    .ok();

    Ok(IndexResult {
        embedded: embedded_vecs.len(),
        deleted: to_delete.len(),
        total,
        duplicate_ids,
        refused_ids,
    })
}


/// Return the note's stable id, assigning and persisting one if absent.
///
/// The id lives in the note's own frontmatter because that is the only place
/// surviving BOTH a rename (which breaks path-derived ids) and an edit (which
/// breaks content-derived ids).
///
/// Writes only when the key is missing. Writing unconditionally would bump
/// mtime on every pass, and the watcher would reindex forever.
pub fn ensure_note_uuid(vault_path: &Path, rel_path: &str) -> anyhow::Result<String> {
    let full = vault_path.join(rel_path);
    let raw = std::fs::read_to_string(&full)?;

    if let Some(existing) = crate::sync::frontmatter::read_key(&raw, "id") {
        if !existing.is_empty() {
            return Ok(existing);
        }
    }

    write_new_uuid(&full, &raw)
}

fn write_new_uuid(full: &Path, raw: &str) -> anyhow::Result<String> {
    let id = uuid::Uuid::now_v7().to_string();
    let updated = crate::sync::frontmatter::upsert_key(raw, "id", &id);
    crate::sync::frontmatter::verify_upsert(raw, &updated, "id", &id)
        .map_err(|why| anyhow::anyhow!("the frontmatter guard refused the rewrite: {why}"))?;
    std::fs::write(full, updated)?;
    Ok(id)
}

pub struct ResolvedIds {
    /// `rel_path -> note_uuid`.
    pub ids: HashMap<String, String>,
    /// `(rel_path, colliding_id)` of every note that had to be given a new id.
    pub reassigned: Vec<(String, String)>,
    /// `(rel_path, reason)` of every note that could not be read or that the
    /// frontmatter guard would not let us rewrite.
    pub refused: Vec<(String, String)>,
}

/// Resolve a stable id for every walked note, reassigning collisions.
///
/// `id:` is user-visible frontmatter and travels when a note body is copied,
/// so two notes sharing an id is a thing that happens, not a thing to assume
/// away - silently collapsing them would point one resolver URL at two
/// different notes. First writer keeps the id; the later note is reassigned on
/// disk, so the collision is resolved rather than merely reported.
///
/// A refused note costs that note, not the run. It is left out of the map, so
/// this run gives it no id: if it is readable and has no row yet, it is
/// indexed with a NULL `note_uuid`, which `export_index` skips, and a row it
/// already has keeps the id it had. It stays in the walk, so the deletion pass
/// leaves its row alone, unless a note that moved onto its path displaces it.
/// Then only the embedding is lost, since its `id:` on disk is still there.
/// The next run tries again. Aborting instead took the whole vault's index
/// down over one file.
pub fn resolve_note_uuids(
    vault_path: &Path,
    entries: &[WalkEntry],
) -> ResolvedIds {
    let mut ids: HashMap<String, String> = HashMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut reassigned: Vec<(String, String)> = Vec::new();
    let mut refused: Vec<(String, String)> = Vec::new();

    for entry in entries {
        let resolved = ensure_note_uuid(vault_path, &entry.rel_path).and_then(|id| {
            if seen.contains(&id) {
                let full = vault_path.join(&entry.rel_path);
                let raw = std::fs::read_to_string(&full)?;
                let fresh = write_new_uuid(&full, &raw)?;
                eprintln!(
                    "WARNING: duplicate note id on {} - reassigned; first writer keeps it",
                    entry.rel_path
                );
                reassigned.push((entry.rel_path.clone(), id));
                Ok(fresh)
            } else {
                Ok(id)
            }
        });

        match resolved {
            Ok(id) => {
                seen.insert(id.clone());
                ids.insert(entry.rel_path.clone(), id);
            }
            Err(why) => {
                eprintln!(
                    "WARNING: {} has no stable id and will not be exported: {why:#}",
                    entry.rel_path
                );
                refused.push((entry.rel_path.clone(), format!("{why:#}")));
            }
        }
    }

    ResolvedIds { ids, reassigned, refused }
}

pub fn walk_vault(vault_path: &str) -> Vec<WalkEntry> {
    let mut entries = Vec::new();
    walk_dir(Path::new(vault_path), Path::new(vault_path), &mut entries);
    entries
}

fn walk_dir(root: &Path, dir: &Path, entries: &mut Vec<WalkEntry>) {
    let read_dir = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }

        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };

        if ft.is_dir() {
            if name_str.starts_with('_') {
                continue;
            }
            walk_dir(root, &path, entries);
        } else if name_str.ends_with(".md") {
            let mtime = match fs::metadata(&path) {
                Ok(m) => {
                    m.modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs_f64() * 1000.0)
                        .unwrap_or(0.0)
                }
                Err(_) => continue,
            };

            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");

            entries.push(WalkEntry {
                rel_path: rel,
                full_path: path.to_string_lossy().to_string(),
                mtime,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::open_or_create_db;
    use tempfile::TempDir;


    #[test]
    fn assigns_a_uuid_to_a_note_without_one() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("note.md");
        std::fs::write(&p, "---\ntitle: T\n---\n\nBody.").unwrap();

        let id = ensure_note_uuid(dir.path(), "note.md").unwrap();
        assert_eq!(id.len(), 36, "uuid v7 hyphenated");

        let raw = std::fs::read_to_string(&p).unwrap();
        assert_eq!(
            crate::sync::frontmatter::read_key(&raw, "id").as_deref(),
            Some(id.as_str())
        );
    }

    #[test]
    fn assignment_is_idempotent_and_does_not_rewrite() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("note.md");
        std::fs::write(&p, "---\ntitle: T\n---\n\nBody.").unwrap();

        let first = ensure_note_uuid(dir.path(), "note.md").unwrap();
        let mtime_after_first = std::fs::metadata(&p).unwrap().modified().unwrap();

        let second = ensure_note_uuid(dir.path(), "note.md").unwrap();
        assert_eq!(first, second);
        assert_eq!(
            std::fs::metadata(&p).unwrap().modified().unwrap(),
            mtime_after_first,
            "a note that already has an id must not be written again - otherwise \
             the watcher observes a change, reindexes, and loops"
        );
    }

    #[test]
    fn id_survives_rename() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("old.md"), "---\ntitle: T\n---\n\nBody.").unwrap();
        let id = ensure_note_uuid(dir.path(), "old.md").unwrap();

        std::fs::rename(dir.path().join("old.md"), dir.path().join("new.md")).unwrap();
        assert_eq!(ensure_note_uuid(dir.path(), "new.md").unwrap(), id);
    }

    #[test]
    fn id_survives_body_edit() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("note.md");
        std::fs::write(&p, "---\ntitle: T\n---\n\nBody.").unwrap();
        let id = ensure_note_uuid(dir.path(), "note.md").unwrap();

        let raw = std::fs::read_to_string(&p).unwrap();
        std::fs::write(&p, raw.replace("Body.", "Rewritten body, entirely different.")).unwrap();
        assert_eq!(ensure_note_uuid(dir.path(), "note.md").unwrap(), id);
    }


    #[test]
    fn resolves_a_uuid_per_entry() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("a.md"), "---\ntitle: A\n---\n\nA.").unwrap();
        std::fs::write(dir.path().join("b.md"), "---\ntitle: B\n---\n\nB.").unwrap();

        let entries = walk_vault(dir.path().to_str().unwrap());
        let ResolvedIds { ids, reassigned: dupes, .. } = resolve_note_uuids(dir.path(), &entries);

        assert_eq!(ids.len(), 2);
        assert!(dupes.is_empty());
        assert_ne!(ids["a.md"], ids["b.md"]);
    }

    #[test]
    fn duplicate_ids_are_detected_and_the_later_note_is_reassigned() {
        let dir = TempDir::new().unwrap();
        let shared = "01926d7e-0000-7000-8000-000000000001";
        std::fs::write(
            dir.path().join("a.md"),
            format!("---\nid: {shared}\ntitle: A\n---\n\nBody A."),
        ).unwrap();
        std::fs::write(
            dir.path().join("b.md"),
            format!("---\nid: {shared}\ntitle: B\n---\n\nBody B."),
        ).unwrap();

        let entries = walk_vault(dir.path().to_str().unwrap());
        let ResolvedIds { ids, reassigned: dupes, .. } = resolve_note_uuids(dir.path(), &entries);

        assert_eq!(dupes.len(), 1, "exactly one loser reported");
        assert_ne!(ids["a.md"], ids["b.md"], "collision resolved");

        let a = std::fs::read_to_string(dir.path().join("a.md")).unwrap();
        let b = std::fs::read_to_string(dir.path().join("b.md")).unwrap();
        let id_a = crate::sync::frontmatter::read_key(&a, "id").unwrap();
        let id_b = crate::sync::frontmatter::read_key(&b, "id").unwrap();
        assert_ne!(id_a, id_b, "resolved on disk, not just in memory");
        assert!(id_a == shared || id_b == shared, "first writer keeps the id");
    }

    #[test]
    fn resolution_is_idempotent_across_runs() {
        let dir = TempDir::new().unwrap();
        let shared = "01926d7e-0000-7000-8000-000000000002";
        std::fs::write(dir.path().join("a.md"), format!("---\nid: {shared}\n---\nA.")).unwrap();
        std::fs::write(dir.path().join("b.md"), format!("---\nid: {shared}\n---\nB.")).unwrap();

        let entries = walk_vault(dir.path().to_str().unwrap());
        let ResolvedIds { ids: first, reassigned: dupes1, .. } = resolve_note_uuids(dir.path(), &entries);
        assert_eq!(dupes1.len(), 1);

        let ResolvedIds { ids: second, reassigned: dupes2, .. } = resolve_note_uuids(dir.path(), &entries);
        assert!(dupes2.is_empty(), "a resolved collision must not re-report forever");
        assert_eq!(first, second, "ids stay put once assigned");
    }

    #[test]
    fn a_refused_note_is_reported_and_the_rest_still_resolve() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("a.md"), "---\ntitle: A\n---\n\nA.").unwrap();
        std::fs::write(dir.path().join("b.md"), b"---\ntitle: B\n---\n\n\xff\xfe").unwrap();
        std::fs::write(dir.path().join("c.md"), "---\ntitle: C\n---\n\nC.").unwrap();

        let entries = walk_vault(dir.path().to_str().unwrap());
        let ResolvedIds { ids, reassigned: dupes, refused } = resolve_note_uuids(dir.path(), &entries);

        assert!(dupes.is_empty());
        assert_eq!(refused.len(), 1);
        assert_eq!(refused[0].0, "b.md");
        assert!(!ids.contains_key("b.md"), "a refused note gets no id");
        assert!(
            ids.contains_key("a.md") && ids.contains_key("c.md"),
            "expected valid notes to receive ids"
        );
        assert_eq!(
            std::fs::read(dir.path().join("b.md")).unwrap(),
            b"---\ntitle: B\n---\n\n\xff\xfe",
            "a refused note is not written"
        );
    }

    fn make_item(path: &str, title: &str, body: &str) -> EmbedItem {
        EmbedItem {
            path: path.to_string(),
            note_uuid: Some(uuid::Uuid::now_v7().to_string()),
            title: title.to_string(),
            tags: String::new(),
            body: body.to_string(),
            text: format!("{title} {body}"),
            hash: format!("hash-{path}"),
            mtime: 1640000000.0,
            links: Vec::new(),
            intentions: Vec::new(),
        }
    }

    fn open_temp_db() -> (TempDir, Connection) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.db").to_str().unwrap().to_string();
        let conn = open_or_create_db(&path).unwrap();
        (dir, conn)
    }

    #[test]
    fn insert_embedded_returns_correct_row_count() {
        let (_dir, conn) = open_temp_db();
        let items = [
            make_item("a.md", "Alpha", "body of alpha"),
            make_item("b.md", "Beta", "body of beta"),
        ];
        let vecs = [vec![0.1_f32; 384], vec![0.2_f32; 384]];
        let refs: Vec<&EmbedItem> = items.iter().collect();

        conn.execute_batch("BEGIN TRANSACTION;").unwrap();
        insert_embedded(&conn, &refs, &vecs).unwrap();
        conn.execute_batch("COMMIT;").unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn insert_embedded_fts_is_searchable_after_insert() {
        let (_dir, conn) = open_temp_db();
        let item = make_item("fts-test.md", "Unique FTS Title", "xyzzy placeholder content");
        let vec = vec![0.5_f32; 384];

        conn.execute_batch("BEGIN TRANSACTION;").unwrap();
        insert_embedded(&conn, &[&item], std::slice::from_ref(&vec)).unwrap();
        conn.execute_batch("COMMIT;").unwrap();

        let hit: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'xyzzy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(hit, 1, "FTS should index the inserted note body");
    }

    #[test]
    fn insert_embedded_upsert_updates_existing_note() {
        let (_dir, conn) = open_temp_db();
        let item_v1 = make_item("upsert.md", "Version 1", "old body");
        let item_v2 = make_item("upsert.md", "Version 2", "new body");
        let vec = vec![0.1_f32; 384];

        conn.execute_batch("BEGIN TRANSACTION;").unwrap();
        insert_embedded(&conn, &[&item_v1], std::slice::from_ref(&vec)).unwrap();
        conn.execute_batch("COMMIT;").unwrap();

        conn.execute_batch("BEGIN TRANSACTION;").unwrap();
        insert_embedded(&conn, &[&item_v2], std::slice::from_ref(&vec)).unwrap();
        conn.execute_batch("COMMIT;").unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "upsert should not duplicate the note");

        let title: String = conn
            .query_row("SELECT title FROM notes WHERE path = 'upsert.md'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(title, "Version 2");
    }

    #[test]
    fn insert_embedded_fts_triggers_restored_after_batch() {
        let (_dir, conn) = open_temp_db();
        let item = make_item("trigger-test.md", "Trigger Test", "initial body");
        let vec = vec![0.1_f32; 384];

        conn.execute_batch("BEGIN TRANSACTION;").unwrap();
        insert_embedded(&conn, &[&item], std::slice::from_ref(&vec)).unwrap();
        conn.execute_batch("COMMIT;").unwrap();

        // Verify the trigger exists again after the batch
        let trigger_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='notes_content_ai'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(trigger_count, 1, "notes_content_ai trigger should be restored after insert_embedded");

        // Verify incremental FTS updates work after restore
        conn.execute(
            "INSERT INTO notes_content (id, title, tags, body) VALUES (9999, 'Manual Insert', '', 'postbatch content')",
            [],
        ).unwrap();
        let fts_hit: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH 'postbatch'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fts_hit, 1, "trigger should fire for inserts after insert_embedded completes");
    }

    /// The absorbing state: a note with an `id:` on disk, a row whose mtime
    /// already agrees with the file, and `note_uuid` NULL.
    ///
    /// It is reached by ordinary use — run 1 writes the `id:` after
    /// `walk_vault` captured the mtime, so the note is skipped; run 2 sees the
    /// new mtime but an unchanged content hash (the hash is taken over the
    /// frontmatter-stripped body) and only writes mtime; run 3 onward the
    /// mtimes agree. From there nothing ever set the column, and
    /// `export_index` filters `WHERE note_uuid IS NOT NULL`, so the note was
    /// silently absent from every sync forever.
    #[test]
    fn an_unchanged_note_gets_its_id_into_the_index_not_only_onto_disk() {
        let dir = TempDir::new().unwrap();
        let db = TempDir::new().unwrap();
        let conn = open_or_create_db(db.path().join("i.db").to_str().unwrap()).unwrap();

        let note = dir.path().join("note.md");
        let id = "01926d7e-0000-7000-8000-00000000000a";
        std::fs::write(&note, format!("---\nid: {id}\ntitle: T\n---\n\nBody.")).unwrap();

        // A row that matches the file in every way except the column. The
        // mtime comes from `walk_vault` itself rather than from `fs::metadata`,
        // because the column's unit is whatever the walker produces — reading
        // it independently is how a fixture ends up describing a note that
        // looks changed, which is a different test from this one.
        let mtime = walk_vault(dir.path().to_str().unwrap())
            .into_iter()
            .next()
            .expect("the walker sees the note")
            .mtime;
        conn.execute(
            "INSERT INTO notes (path, content_hash, mtime, title, tags, note_uuid)
             VALUES ('note.md', 'unchanged', ?1, 'T', '', NULL)",
            rusqlite::params![mtime],
        )
        .unwrap();

        reindex(&conn, dir.path().to_str().unwrap(), false).unwrap();

        let got: Option<String> = conn
            .query_row("SELECT note_uuid FROM notes WHERE path = 'note.md'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            got.as_deref(),
            Some(id),
            "a skipped note must still get the id it already carries on disk; without it \
             the note is unaddressable and every export drops it"
        );
    }

    /// Promoting a note from `0-inbox/` to `3-permanent/` must not break the
    /// index.
    ///
    /// The stale row holds the uuid; the file now carries it at a new path.
    /// Inserting that as a new row hits `idx_notes_uuid` and aborts the whole
    /// reindex, not just the one note — and the deletion pass that would clear
    /// the stale row runs after the inserts, so it never gets there. Found on
    /// a real vault, where a single promoted note had made the index
    /// unrebuildable.
    #[test]
    fn a_note_that_moved_follows_its_id_instead_of_colliding_with_itself() {
        let dir = TempDir::new().unwrap();
        let db = TempDir::new().unwrap();
        let conn = open_or_create_db(db.path().join("i.db").to_str().unwrap()).unwrap();

        std::fs::create_dir_all(dir.path().join("3-permanent")).unwrap();
        let id = "01926d7e-0000-7000-8000-00000000000b";
        std::fs::write(
            dir.path().join("3-permanent/note.md"),
            format!("---\nid: {id}\ntitle: T\n---\n\nBody."),
        )
        .unwrap();

        // The row the vault left behind when the note was promoted, carrying
        // the file's real mtime: a promotion moves the note, it does not edit
        // it, so the row must end up skipped rather than re-embedded.
        let mtime = walk_vault(dir.path().to_str().unwrap())
            .into_iter()
            .next()
            .expect("the walker sees the note")
            .mtime;
        conn.execute(
            "INSERT INTO notes (path, content_hash, mtime, title, tags, note_uuid)
             VALUES ('0-inbox/note.md', 'h', ?2, 'T', '', ?1)",
            rusqlite::params![id, mtime],
        )
        .unwrap();

        reindex(&conn, dir.path().to_str().unwrap(), false)
            .expect("a promoted note must not abort the reindex");

        let rows: i64 = conn
            .query_row("SELECT count(*) FROM notes WHERE note_uuid = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "one note, one row: the id must not be duplicated");
        let path: String = conn
            .query_row("SELECT path FROM notes WHERE note_uuid = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(path, "3-permanent/note.md", "the row must follow the note to its new path");
        let hash: String = conn
            .query_row("SELECT content_hash FROM notes WHERE note_uuid = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(
            hash, "h",
            "a move is not a content change; the row keeps its embedding rather than being \
             re-embedded for having changed folder"
        );
    }

    /// Two notes that exchange paths must exchange rows, not identities.
    ///
    /// `note_uuid` is the address federation publishes a note under, so a row
    /// that keeps its old id while the other note's file arrives at its path
    /// publishes one note's body under the other's id. The old guard refused
    /// BOTH moves — each destination was held by the row that was itself about
    /// to leave — and left each row sitting under a path whose file is now a
    /// different note.
    ///
    /// Both files carry the same mtime, which is what a swap done by one
    /// script produces, and it keeps the assertion on identity: nothing is
    /// re-read or re-embedded, so what the rows say afterwards is entirely the
    /// work of the move pass.
    #[test]
    fn two_notes_that_swap_paths_swap_rows_rather_than_identities() {
        let dir = TempDir::new().unwrap();
        let db = TempDir::new().unwrap();
        let conn = open_or_create_db(db.path().join("i.db").to_str().unwrap()).unwrap();

        let id_a = "01926d7e-0000-7000-8000-0000000000a0";
        let id_b = "01926d7e-0000-7000-8000-0000000000b0";

        // On disk AFTER the swap: a.md holds the note whose id is B.
        std::fs::write(
            dir.path().join("a.md"),
            format!("---\nid: {id_b}\ntitle: B\n---\n\nBody of B."),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("b.md"),
            format!("---\nid: {id_a}\ntitle: A\n---\n\nBody of A."),
        )
        .unwrap();

        let mtimes: HashMap<String, f64> = walk_vault(dir.path().to_str().unwrap())
            .into_iter()
            .map(|e| (e.rel_path, e.mtime))
            .collect();

        // The index as it stood BEFORE the swap: A at a.md, B at b.md. Each
        // row carries the mtime of the file it will end up under, so a correct
        // move leaves both notes unchanged rather than re-embedded.
        conn.execute(
            "INSERT INTO notes (path, content_hash, mtime, title, tags, note_uuid)
             VALUES ('a.md', 'hash-a', ?2, 'A', '', ?1)",
            rusqlite::params![id_a, mtimes["b.md"]],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes (path, content_hash, mtime, title, tags, note_uuid)
             VALUES ('b.md', 'hash-b', ?2, 'B', '', ?1)",
            rusqlite::params![id_b, mtimes["a.md"]],
        )
        .unwrap();

        reindex(&conn, dir.path().to_str().unwrap(), false)
            .expect("a swap must not abort the reindex");

        let path_of = |id: &str| -> String {
            conn.query_row("SELECT path FROM notes WHERE note_uuid = ?1", [id], |r| r.get(0))
                .unwrap()
        };
        let title_at = |path: &str| -> String {
            conn.query_row("SELECT title FROM notes WHERE path = ?1", [path], |r| r.get(0))
                .unwrap()
        };

        assert_eq!(path_of(id_a), "b.md", "note A must follow its id to b.md");
        assert_eq!(path_of(id_b), "a.md", "note B must follow its id to a.md");
        assert_eq!(
            title_at("a.md"),
            "B",
            "the row at a.md must be the row for the note now at a.md; holding id A there \
             publishes B's body under A's id"
        );
        assert_eq!(title_at("b.md"), "A", "and the same the other way round");

        let rows: i64 =
            conn.query_row("SELECT count(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 2, "two notes, two rows");
    }

    /// Lay `(path, note_uuid)` rows down and hand back the connection, so a
    /// test of the move pass says only what it is about.
    #[cfg(test)]
    fn rows_at(db: &TempDir, rows: &[(&str, Option<&str>)]) -> Connection {
        let conn = open_or_create_db(db.path().join("i.db").to_str().unwrap()).unwrap();
        for (path, uuid) in rows {
            conn.execute(
                "INSERT INTO notes (path, content_hash, mtime, title, tags, note_uuid)
                 VALUES (?1, 'h', 1.0, ?1, '', ?2)",
                rusqlite::params![path, uuid],
            )
            .unwrap();
        }
        conn
    }

    /// Build the `(WalkEntry, note_uuids)` pair the move pass takes, without
    /// touching a disk: what it does is decided entirely by the mapping.
    #[cfg(test)]
    fn desired(pairs: &[(&str, &str)]) -> (Vec<WalkEntry>, HashMap<String, String>) {
        let files: Vec<WalkEntry> = pairs
            .iter()
            .map(|(path, _)| WalkEntry {
                rel_path: (*path).to_string(),
                full_path: (*path).to_string(),
                mtime: 1.0,
            })
            .collect();
        let ids = pairs
            .iter()
            .map(|(path, id)| ((*path).to_string(), (*id).to_string()))
            .collect();
        (files, ids)
    }

    /// A swap is the shortest cycle, not a case of its own. Three notes
    /// rotating through each other's paths is the same permutation problem,
    /// and the old per-row guard refused all three moves for the same reason
    /// it refused both halves of a swap.
    #[test]
    fn a_three_way_rotation_lands_every_note_on_its_own_path() {
        let db = TempDir::new().unwrap();
        let (ida, idb, idc) = ("id-a", "id-b", "id-c");
        let conn = rows_at(
            &db,
            &[("a.md", Some(ida)), ("b.md", Some(idb)), ("c.md", Some(idc))],
        );

        // a -> b -> c -> a
        let (files, ids) = desired(&[("b.md", ida), ("c.md", idb), ("a.md", idc)]);
        let moved = follow_moved_notes(&conn, &files, &ids).unwrap();

        assert_eq!(moved, 3, "all three rows moved");
        for (id, path) in [(ida, "b.md"), (idb, "c.md"), (idc, "a.md")] {
            let got: String = conn
                .query_row("SELECT path FROM notes WHERE note_uuid = ?1", [id], |r| r.get(0))
                .unwrap();
            assert_eq!(got, path, "{id} must land on {path}");
        }
    }

    /// A row already where it belongs is not touched, and is not counted as a
    /// move. Without this the parking pass could churn the whole table on
    /// every reindex and the log would claim a vault-sized migration each run.
    #[test]
    fn a_note_that_did_not_move_is_left_alone() {
        let db = TempDir::new().unwrap();
        let conn = rows_at(&db, &[("a.md", Some("id-a")), ("b.md", Some("id-b"))]);
        let (files, ids) = desired(&[("a.md", "id-a"), ("b.md", "id-b")]);

        assert_eq!(follow_moved_notes(&conn, &files, &ids).unwrap(), 0);
        let paths: Vec<String> = conn
            .prepare("SELECT path FROM notes ORDER BY path")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(paths, vec!["a.md".to_string(), "b.md".to_string()]);
    }

    /// A row holding a path that now belongs to a different id, with no claim
    /// of its own — an index written before ids existed, whose note was
    /// replaced in place. It must not block the rightful id from landing, and
    /// it must not survive: it is parked, which puts it outside `vault_paths`,
    /// and `reindex`'s deletion pass collects it from there.
    #[test]
    fn a_row_squatting_on_another_notes_path_yields_it() {
        let db = TempDir::new().unwrap();
        let conn = rows_at(&db, &[("a.md", None), ("b.md", Some("id-b"))]);
        let (files, ids) = desired(&[("a.md", "id-b")]);

        assert_eq!(follow_moved_notes(&conn, &files, &ids).unwrap(), 1);

        let landed: String = conn
            .query_row("SELECT path FROM notes WHERE note_uuid = 'id-b'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(landed, "a.md", "the id that owns a.md must get it");

        let ghost: String = conn
            .query_row("SELECT path FROM notes WHERE note_uuid IS NULL", [], |r| r.get(0))
            .unwrap();
        assert!(
            !ghost.ends_with(".md"),
            "the squatter must be left outside the vault's path space so the deletion \
             pass reaches it, got {ghost}"
        );
    }


    /// Pins the NULL-`note_uuid` blind spot so the doc comment above cannot
    /// drift back into claiming coverage this pass does not have.
    ///
    /// Asserting the LIMITATION rather than the fix is deliberate: the two
    /// statements are keyed on `note_uuid`, so id-less rows are invisible to
    /// both, and a reader who trusts "two notes that swap paths swap rows"
    /// would be wrong for exactly the population a freshly-upgraded index is
    /// made of. If someone teaches the pass to handle NULL rows, this test
    /// fails and tells them to update the comment with the good news.
    #[test]
    fn the_move_pass_is_a_no_op_for_rows_that_have_no_id_yet() {
        let db = TempDir::new().unwrap();
        let conn = rows_at(&db, &[("a.md", None), ("b.md", None)]);
        // The mapping a swap produces: each path now belongs to the other id.
        let (files, ids) = desired(&[("a.md", "id-b"), ("b.md", "id-a")]);

        assert_eq!(
            follow_moved_notes(&conn, &files, &ids).unwrap(),
            0,
            "no id on the rows means nothing for this pass to follow"
        );
        let paths: Vec<String> = conn
            .prepare("SELECT path FROM notes ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(
            paths,
            vec!["a.md".to_string(), "b.md".to_string()],
            "the rows are left exactly where they were; the backfill, not this pass, \
             decides what id they get, and it decides by path"
        );
    }


    /// The mixed, ordinary case: one id-less row, one with an id. The park is
    /// keyed on PATH, not on the candidate's `note_uuid`, so the id-less row
    /// IS parked here — it holds a path that another row's id now owns. It can
    /// never land, so it stays parked, outside `vault_paths`, and `reindex`'s
    /// deletion pass collects it.
    ///
    /// That is the safe outcome and the counterexample to "the pass ignores
    /// NULL rows", which is what the doc used to say. Losing the row costs its
    /// embedding; it costs no identity, because the note's `id:` is on disk and
    /// it is re-indexed as itself.
    #[test]
    fn an_id_less_row_holding_another_notes_path_is_parked_and_left_for_collection() {
        let db = TempDir::new().unwrap();
        let conn = rows_at(&db, &[("a.md", None), ("b.md", Some("id-b"))]);
        let (files, ids) = desired(&[("a.md", "id-b"), ("b.md", "id-a")]);

        assert_eq!(follow_moved_notes(&conn, &files, &ids).unwrap(), 1, "id-b lands on a.md");

        let landed: String = conn
            .query_row("SELECT path FROM notes WHERE note_uuid = 'id-b'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(landed, "a.md");

        let ghost: String = conn
            .query_row("SELECT path FROM notes WHERE note_uuid IS NULL", [], |r| r.get(0))
            .unwrap();
        assert!(
            !ghost.ends_with(".md"),
            "the id-less row must be parked outside the vault's path space, got {ghost}"
        );
    }

}
