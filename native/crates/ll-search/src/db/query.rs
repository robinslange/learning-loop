use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Serialize;

use super::index::walk_vault;

#[derive(Serialize)]
pub struct Status {
    #[serde(rename = "noteCount")]
    pub note_count: i64,
    #[serde(rename = "vaultFileCount")]
    pub vault_file_count: usize,
    #[serde(rename = "missingFromIndex")]
    pub missing_from_index: i64,
    #[serde(rename = "modelId")]
    pub model_id: String,
    pub dtype: String,
    #[serde(rename = "schemaVersion")]
    pub schema_version: String,
    #[serde(rename = "indexedAt")]
    pub indexed_at: String,
}

#[derive(Serialize)]
pub struct TagInfo {
    pub tag: String,
    pub count: usize,
    pub first_mtime: f64,
    pub last_mtime: f64,
}

#[derive(Serialize)]
pub struct SessionInfo {
    pub session_id: i64,
    pub note_count: usize,
    pub first_mtime: f64,
    pub last_mtime: f64,
    pub sample_titles: Vec<String>,
}

#[derive(Serialize)]
pub struct FolderStats {
    pub count: i64,
    pub zero_inlinks: i64,
}

#[derive(Serialize)]
pub struct LinkStats {
    pub total_notes: i64,
    pub total_links: i64,
    pub by_folder: HashMap<String, FolderStats>,
    pub permanent_to_maps_ratio: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orphans: Option<Vec<String>>,
}

pub fn load_embedding(conn: &Connection, note_id: i64) -> Option<Vec<f32>> {
    conn.query_row(
        "SELECT data FROM embeddings WHERE id = ?1",
        params![note_id],
        |row| {
            let blob: Vec<u8> = row.get(0)?;
            Ok(blob
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect())
        },
    )
    .ok()
}

pub fn load_all_embeddings(conn: &Connection) -> Vec<(i64, String, Vec<f32>)> {
    let mut stmt = match conn.prepare(
        "SELECT e.id, n.path, e.data FROM embeddings e JOIN notes n ON e.id = n.id",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows = match stmt.query_map([], |row| {
        let id: i64 = row.get(0)?;
        let path: String = row.get(1)?;
        let blob: Vec<u8> = row.get(2)?;
        let vec: Vec<f32> = blob
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        Ok((id, path, vec))
    }) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    rows.filter_map(|r| r.ok()).collect()
}

pub fn get_status(conn: &Connection, vault_path: &str) -> Status {
    let mut meta: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT key, value FROM meta").unwrap();
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap();
        for row in rows {
            let (k, v) = row.unwrap();
            meta.insert(k, v);
        }
    }

    let note_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .unwrap_or(0);

    let vault_files = walk_vault(vault_path);

    Status {
        note_count,
        vault_file_count: vault_files.len(),
        missing_from_index: vault_files.len() as i64 - note_count,
        model_id: meta
            .get("model_id")
            .cloned()
            .unwrap_or_else(|| "unknown".into()),
        dtype: meta
            .get("dtype")
            .cloned()
            .unwrap_or_else(|| "unknown".into()),
        schema_version: meta
            .get("schema_version")
            .cloned()
            .unwrap_or_else(|| "unknown".into()),
        indexed_at: meta
            .get("indexed_at")
            .cloned()
            .unwrap_or_else(|| "never".into()),
    }
}

pub fn list_tags(conn: &Connection, min_count: usize) -> Vec<TagInfo> {
    let mut result: Vec<TagInfo> = Vec::new();

    if let Ok(mut stmt) = conn.prepare(
        "SELECT tag, note_count, first_mtime, last_mtime FROM project_phases WHERE note_count >= ?1 ORDER BY note_count DESC"
    ) {
        if let Ok(rows) = stmt.query_map(params![min_count as i64], |row| {
            Ok(TagInfo {
                tag: row.get(0)?,
                count: row.get::<_, i64>(1)? as usize,
                first_mtime: row.get(2)?,
                last_mtime: row.get(3)?,
            })
        }) {
            result = rows.filter_map(|r| r.ok()).collect();
        }
    }

    result
}

pub fn compute_sessions(conn: &Connection) {
    let has_session_col = conn.prepare("SELECT session_id FROM notes LIMIT 0").is_ok();
    if !has_session_col {
        conn.execute_batch("ALTER TABLE notes ADD COLUMN session_id INTEGER;").unwrap();
    }

    let mut notes: Vec<(i64, f64)> = Vec::new();
    if let Ok(mut stmt) = conn.prepare("SELECT id, mtime FROM notes ORDER BY mtime") {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?))
        }) {
            for row in rows.flatten() {
                notes.push(row);
            }
        }
    }

    if notes.is_empty() {
        return;
    }

    let gaps_min: Vec<f64> = notes.windows(2)
        .map(|w| ((w[1].1 - w[0].1) / 60_000.0).max(0.0))
        .collect();

    let threshold_min = find_session_threshold(&gaps_min);
    eprintln!("Session threshold: {:.0} minutes ({} notes)", threshold_min, notes.len());

    let mut session_id: i64 = 0;
    let mut assignments: Vec<(i64, i64)> = Vec::with_capacity(notes.len());
    assignments.push((notes[0].0, session_id));

    for i in 1..notes.len() {
        let gap_min = (notes[i].1 - notes[i - 1].1) / 60_000.0;
        if gap_min > threshold_min {
            session_id += 1;
        }
        assignments.push((notes[i].0, session_id));
    }

    conn.execute_batch("BEGIN TRANSACTION;").unwrap();
    for (note_id, sid) in &assignments {
        conn.execute(
            "UPDATE notes SET session_id = ?1 WHERE id = ?2",
            params![sid, note_id],
        ).ok();
    }
    conn.execute_batch("COMMIT;").unwrap();

    eprintln!("Assigned {} sessions across {} notes", session_id + 1, notes.len());
}

fn find_session_threshold(gaps_min: &[f64]) -> f64 {
    if gaps_min.is_empty() {
        return 30.0;
    }

    let max_bucket = 480;
    let mut counts = vec![0u32; max_bucket + 1];
    for &g in gaps_min {
        let bucket = (g as usize).min(max_bucket);
        counts[bucket] += 1;
    }

    let window = 10i32;
    let mut smoothed = vec![0.0f64; max_bucket + 1];
    for m in 0..=max_bucket {
        let mut sum = 0.0;
        let mut n = 0;
        for d in -window..=window {
            let idx = m as i32 + d;
            if idx >= 0 && idx <= max_bucket as i32 {
                sum += counts[idx as usize] as f64;
                n += 1;
            }
        }
        smoothed[m] = sum / n as f64;
    }

    let search_start = 15;
    let search_end = 120.min(max_bucket);
    let mut min_val = f64::MAX;
    let mut min_idx = 30;

    for m in search_start..=search_end {
        if smoothed[m] < min_val {
            min_val = smoothed[m];
            min_idx = m;
        }
    }

    min_idx as f64
}

pub fn compute_project_phases(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_phases (
            tag TEXT PRIMARY KEY,
            first_mtime REAL,
            last_mtime REAL,
            note_count INTEGER
        );"
    ).ok();

    let mut tag_data: HashMap<String, (f64, f64, usize)> = HashMap::new();

    if let Ok(mut stmt) = conn.prepare("SELECT tags, mtime FROM notes WHERE tags IS NOT NULL AND tags != ''") {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        }) {
            for row in rows.flatten() {
                let (tags_str, mtime) = row;
                let mtime_sec = mtime / 1000.0;
                for tag in tags_str.split_whitespace() {
                    let tag = tag.to_lowercase();
                    if tag.is_empty() {
                        continue;
                    }
                    let entry = tag_data.entry(tag).or_insert((f64::MAX, f64::MIN, 0));
                    entry.0 = entry.0.min(mtime_sec);
                    entry.1 = entry.1.max(mtime_sec);
                    entry.2 += 1;
                }
            }
        }
    }

    conn.execute_batch("DELETE FROM project_phases;").ok();
    for (tag, (first, last, count)) in &tag_data {
        if *count >= 3 {
            conn.execute(
                "INSERT OR REPLACE INTO project_phases (tag, first_mtime, last_mtime, note_count) VALUES (?1, ?2, ?3, ?4)",
                params![tag, first, last, count],
            ).ok();
        }
    }

    eprintln!("Computed {} project phase tags", tag_data.len());
}

pub fn list_sessions(conn: &Connection, min_notes: usize) -> Vec<SessionInfo> {
    let has_session_col = conn.prepare("SELECT session_id FROM notes LIMIT 0").is_ok();
    if !has_session_col {
        return Vec::new();
    }

    let mut sessions: HashMap<i64, (usize, f64, f64, Vec<String>)> = HashMap::new();

    if let Ok(mut stmt) = conn.prepare(
        "SELECT n.session_id, n.mtime, nc.title FROM notes n LEFT JOIN notes_content nc ON n.id = nc.id WHERE n.session_id IS NOT NULL ORDER BY n.mtime"
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        }) {
            for row in rows.flatten() {
                let (sid, mtime, title) = row;
                let mtime_sec = mtime / 1000.0;
                let entry = sessions.entry(sid).or_insert((0, f64::MAX, f64::MIN, Vec::new()));
                entry.0 += 1;
                entry.1 = entry.1.min(mtime_sec);
                entry.2 = entry.2.max(mtime_sec);
                if entry.3.len() < 3 {
                    if let Some(t) = title {
                        entry.3.push(t);
                    }
                }
            }
        }
    }

    let mut result: Vec<SessionInfo> = sessions
        .into_iter()
        .filter(|(_, (count, _, _, _))| *count >= min_notes)
        .map(|(sid, (count, first, last, titles))| SessionInfo {
            session_id: sid,
            note_count: count,
            first_mtime: first,
            last_mtime: last,
            sample_titles: titles,
        })
        .collect();

    result.sort_by(|a, b| b.first_mtime.partial_cmp(&a.first_mtime).unwrap_or(std::cmp::Ordering::Equal));
    result
}

pub fn link_stats(conn: &Connection, folder_filter: Option<&str>, include_orphans: bool) -> LinkStats {
    let total_notes: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .unwrap_or(0);

    let total_links: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM links WHERE target_path NOT LIKE '%[%'",
            [], |r| r.get(0),
        )
        .unwrap_or(0);

    let mut folder_counts: HashMap<String, (i64, i64)> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT path FROM notes").unwrap();
        let paths: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        for path in &paths {
            let folder = path.split('/').next().unwrap_or("").to_string();
            folder_counts.entry(folder).or_insert((0, 0)).0 += 1;
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT n.path FROM notes n \
             WHERE NOT EXISTS ( \
               SELECT 1 FROM links l \
               WHERE l.target_path = REPLACE( \
                 REPLACE(n.path, '.md', ''), \
                 SUBSTR(n.path, 1, INSTR(n.path, '/')), '') \
               AND l.target_path NOT LIKE '%[%' \
             )"
        ).unwrap();
        let orphan_paths: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        for path in &orphan_paths {
            let folder = path.split('/').next().unwrap_or("").to_string();
            if let Some(entry) = folder_counts.get_mut(&folder) {
                entry.1 += 1;
            }
        }
    }

    let by_folder: HashMap<String, FolderStats> = folder_counts
        .into_iter()
        .map(|(k, (count, zero))| (k, FolderStats { count, zero_inlinks: zero }))
        .collect();

    let perm_count = by_folder.get("3-permanent").map(|f| f.count).unwrap_or(0) as f64;
    let maps_count = by_folder.get("5-maps").map(|f| f.count).unwrap_or(1).max(1) as f64;

    let orphans = if include_orphans {
        let filter = folder_filter.unwrap_or("3-permanent/");
        let mut stmt = conn.prepare(
            "SELECT n.path FROM notes n \
             WHERE n.path LIKE ?1 \
             AND NOT EXISTS ( \
               SELECT 1 FROM links l \
               WHERE l.target_path = REPLACE( \
                 REPLACE(n.path, '.md', ''), \
                 SUBSTR(n.path, 1, INSTR(n.path, '/')), '') \
               AND l.target_path NOT LIKE '%[%' \
             ) ORDER BY n.path"
        ).unwrap();
        Some(stmt
            .query_map(params![format!("{}%", filter)], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect())
    } else {
        None
    };

    LinkStats {
        total_notes,
        total_links,
        by_folder,
        permanent_to_maps_ratio: (perm_count / maps_count * 100.0).round() / 100.0,
        orphans,
    }
}

pub fn chrono_iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let minutes = (time_secs % 3600) / 60;
    let seconds = time_secs % 60;

    let (year, month, day) = days_to_ymd(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, minutes, seconds
    )
}

pub fn days_to_ymd(days_since_epoch: u64) -> (u64, u64, u64) {
    let z = days_since_epoch + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
