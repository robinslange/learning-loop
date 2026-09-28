//! UDS server hosted inside `ll-search watch`.
//!
//! Wire contract (line-delimited JSON, one request per connection — no keep-alive).
//!
//!   Dup request:    {"kind": "duplicate-scan", "queries": ["..."], "top": 1, "candidates": 5, "schema_version": 1 (optional)}\n
//!   Dup response:   {"schema_version": 1, "queries": [{...}], "confusable_pairs": [...]}\n
//!
//!   Error:          {"schema_version": 1, "error": "..."}\n
//!
//! The embedding model is loaded once (lazily, on the first request) inside
//! the daemon and reused thereafter — no per-request re-load.
//!
//! The server is unix-only. On non-unix platforms the daemon-side wiring is
//! a no-op.

#![cfg(unix)]

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::watch as watch_chan;
use tokio::task::JoinSet;

use crate::app::AppState;
use crate::search::SearchContext;

/// Default discriminate threshold for daemon-served duplicate scans. Matches
/// the `reflect-scan` CLI default (`main.rs` ReflectScan `threshold`) so the
/// socket path and the subprocess fallback produce identical confusable-pair
/// surfaces.
const DUPLICATE_SCAN_DISCRIMINATE_THRESHOLD: f32 = 0.85;

/// Cap on a single request line. UDS is local-only but a buggy / malicious
/// client could otherwise stream gigabytes with no `\n` and exhaust memory.
const MAX_REQUEST_BYTES: u64 = 1 << 20; // 1 MiB

/// Probe timeout when checking whether an existing socket file is alive.
/// A wedged daemon (accepting but never responding) would otherwise let
/// connect() succeed instantly via the kernel backlog and we'd refuse to
/// start against a zombie.
const STALE_SOCKET_PROBE_TIMEOUT: Duration = Duration::from_millis(500);

/// How long we wait for in-flight connection handlers to finish responding
/// after a shutdown signal arrives. Aligned with watch.rs SHUTDOWN_DRAIN.
const SHUTDOWN_DRAIN: Duration = Duration::from_secs(2);

fn default_dup_top() -> usize {
    1
}

fn default_dup_candidates() -> usize {
    5
}

#[derive(Deserialize)]
struct DuplicateScanRequest {
    kind: String,
    queries: Vec<String>,
    #[serde(default = "default_dup_top")]
    top: usize,
    #[serde(default = "default_dup_candidates")]
    candidates: usize,
    #[serde(default)]
    #[allow(dead_code)]
    schema_version: Option<u32>,
}

#[derive(Serialize)]
struct ProtocolError {
    schema_version: u32,
    error: String,
}

/// Spawn the UDS socket server. Returns immediately; runs until `shutdown_rx`
/// flips to true. Cleans up the socket file on shutdown and drains in-flight
/// handlers within `SHUTDOWN_DRAIN`.
///
/// `db_path` is the search index the daemon already maintains. Each
/// duplicate-scan request opens its own read connection for the scan; the
/// `SearchContext` over the index is built once and kept until a reindex
/// makes it stale (see [`ScanIndex`]).
pub async fn run_dup_scan_server(
    socket_path: PathBuf,
    db_path: PathBuf,
    mut shutdown_rx: watch_chan::Receiver<bool>,
) -> anyhow::Result<()> {
    let index = Arc::new(ScanIndex::new(db_path));
    if socket_path.exists() {
        // Probe with a timeout — a wedged daemon could otherwise let bare
        // connect() succeed instantly via the OS backlog.
        match tokio::time::timeout(
            STALE_SOCKET_PROBE_TIMEOUT,
            UnixStream::connect(&socket_path),
        )
        .await
        {
            Ok(Ok(_)) => {
                anyhow::bail!(
                    "UDS socket {} is already in use by another daemon — refusing to start",
                    socket_path.display()
                );
            }
            Ok(Err(_)) | Err(_) => {
                // Connect refused / timed out → socket is stale (previous
                // daemon crashed without cleanup or is wedged). Unlink and
                // rebind. There's a TOCTOU window before bind, accepted as
                // single-user-vault risk.
                let _ = std::fs::remove_file(&socket_path);
            }
        }
    }

    let listener = UnixListener::bind(&socket_path)
        .map_err(|e| anyhow::anyhow!("bind UDS socket {}: {e}", socket_path.display()))?;
    // 0700 — same user only. UDS files inherit the process umask; tighten
    // explicitly so a permissive umask doesn't leak access to other users
    // on shared hosts. Window between bind() and chmod is accepted (local
    // single-user trust model).
    if let Err(e) = restrict_socket_permissions(&socket_path) {
        eprintln!("warning: failed to restrict UDS socket permissions: {e}");
    }
    eprintln!("UDS server listening on {}", socket_path.display());

    // JoinSet lets us drain in-flight connection handlers on shutdown.
    let mut handlers: JoinSet<()> = JoinSet::new();

    let socket_path_for_cleanup = socket_path.clone();
    let result = loop {
        tokio::select! {
            biased;
            _ = shutdown_rx.changed() => break Ok(()),
            // Reap finished handlers so JoinSet doesn't grow unboundedly
            // for a long-running daemon. Errors are logged at handler exit
            // already, so the JoinSet panic surface is just defensive.
            Some(join_res) = handlers.join_next() => {
                if let Err(e) = join_res {
                    if e.is_panic() {
                        eprintln!("UDS server handler panicked: {e}");
                    }
                }
            }
            accept = listener.accept() => {
                match accept {
                    Ok((stream, _addr)) => {
                        let index = Arc::clone(&index);
                        handlers.spawn(async move {
                            if let Err(e) = handle_connection(stream, index).await {
                                eprintln!("UDS server connection error: {e}");
                            }
                        });
                    }
                    Err(e) => {
                        eprintln!("UDS server accept error: {e}");
                        // Brief backoff to avoid tight error loops on persistent
                        // accept failures (fd exhaustion, etc.).
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
            }
        }
    };

    eprintln!(
        "UDS server: draining {} in-flight handlers (timeout {}s)",
        handlers.len(),
        SHUTDOWN_DRAIN.as_secs()
    );
    let _ = tokio::time::timeout(SHUTDOWN_DRAIN, async {
        while handlers.join_next().await.is_some() {}
    })
    .await;
    let leftover = handlers.len();
    if leftover > 0 {
        eprintln!(
            "UDS server: {leftover} handler(s) still running after drain — aborting",
        );
        handlers.abort_all();
    }

    let _ = std::fs::remove_file(&socket_path_for_cleanup);
    eprintln!("UDS server stopped");
    result
}

async fn handle_connection(stream: UnixStream, index: Arc<ScanIndex>) -> anyhow::Result<()> {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half).take(MAX_REQUEST_BYTES);
    let mut line = String::new();
    let bytes = reader.read_line(&mut line).await?;
    if bytes == 0 {
        return Ok(());
    }
    // .take() returns Ok up to the limit; if we hit the cap without a newline,
    // line ends without '\n'. Detect and reject before parsing — the line is
    // almost certainly truncated.
    if !line.ends_with('\n') && bytes as u64 == MAX_REQUEST_BYTES {
        let err = protocol_error(format!(
            "request exceeded max size {} bytes without terminating newline",
            MAX_REQUEST_BYTES
        ));
        write_half.write_all(err.as_bytes()).await?;
        write_half.write_all(b"\n").await?;
        write_half.flush().await?;
        return Ok(());
    }

    let response = match serde_json::from_str::<DuplicateScanRequest>(&line) {
        Ok(req) => {
            if req.kind != "duplicate-scan" {
                protocol_error(format!("unknown request kind: {}", req.kind))
            } else {
                // Same shape as `reflect-scan`: open a read connection against
                // the daemon's index, run the scan with the warm embedding +
                // rerank models, and return the reflect envelope. spawn_blocking
                // keeps the SQLite + ONNX work off the tokio worker.
                let result = tokio::task::spawn_blocking(move || run_duplicate_scan(&index, &req))
                    .await;
                match result {
                    Ok(Ok(scan)) => serde_json::to_string(&scan)
                        .unwrap_or_else(|e| protocol_error(format!("serialize response: {e}"))),
                    Ok(Err(e)) => protocol_error(format!("duplicate scan: {e:#}")),
                    Err(join_err) => protocol_error(format!("scan task panicked: {join_err}")),
                }
            }
        }
        Err(parse_err) => protocol_error(format!("parse request: {parse_err}")),
    };

    write_half.write_all(response.as_bytes()).await?;
    write_half.write_all(b"\n").await?;
    write_half.flush().await?;
    Ok(())
}

/// The daemon's index, and the `SearchContext` cached over it.
///
/// The connection the cache is checked through stays open for the daemon's
/// lifetime. Staleness is read from `PRAGMA data_version`, which moves only
/// for a connection that was already open when another one wrote: a fresh
/// connection reads the same value every time, so a cache checked through one
/// would never see a reindex. Both are opened on the first scan rather than at
/// startup, so a daemon whose index is not there yet still starts, and serves
/// once it is.
struct ScanIndex {
    db_path: PathBuf,
    warm: Mutex<Option<(Connection, AppState)>>,
}

impl ScanIndex {
    fn new(db_path: PathBuf) -> Self {
        Self { db_path, warm: Mutex::new(None) }
    }

    fn search_context(&self) -> anyhow::Result<Arc<SearchContext>> {
        let mut warm = self.warm.lock();
        let (conn, app) = match &mut *warm {
            Some(open) => open,
            empty => empty.insert((self.open()?, AppState::from_db(&self.db_path.to_string_lossy(), None)?)),
        };
        Ok(app.ensure_search_context(conn))
    }

    fn open(&self) -> anyhow::Result<Connection> {
        crate::db::open_db(&self.db_path.to_string_lossy())
            .map_err(|e| anyhow::anyhow!("open index {}: {e:#}", self.db_path.display()))
    }
}

/// Run a reflect-style duplicate scan against the daemon's index, reusing the
/// same `reflect_scan` pipeline the `reflect-scan` CLI command calls. The
/// embedding provider is lazily initialised on first use and reused for the
/// daemon's lifetime, so a duplicate-scan request never re-loads the model.
fn run_duplicate_scan(
    index: &ScanIndex,
    req: &DuplicateScanRequest,
) -> anyhow::Result<crate::search::ReflectScanResult> {
    // Lazy, idempotent: the embedding provider is a global OnceLock, so the
    // first scan pays the load cost and subsequent scans reuse it. init is a
    // no-op when already initialised with the same model.
    crate::embed::init_provider(&crate::model::KnownModel::BgeSmallEnV15)?;

    let ctx = index.search_context()?;
    let conn = index.open()?;
    crate::search::reflect_scan(
        &ctx,
        &conn,
        &[],
        &req.queries,
        req.top,
        req.candidates,
        DUPLICATE_SCAN_DISCRIMINATE_THRESHOLD,
    )
}

const PROTOCOL_SCHEMA_VERSION: u32 = 1;

fn protocol_error(message: String) -> String {
    serde_json::to_string(&ProtocolError {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        error: message,
    })
    .unwrap_or_else(|_| String::from(r#"{"schema_version":1,"error":"unserializable error"}"#))
}

fn restrict_socket_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o700);
    std::fs::set_permissions(path, perms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_scan_request_parses_with_defaults() {
        let line = r#"{"kind":"duplicate-scan","queries":["sleep memory"]}"#;
        let req: DuplicateScanRequest = serde_json::from_str(line).expect("dup-scan request parses");
        assert_eq!(req.kind, "duplicate-scan");
        assert_eq!(req.queries, vec!["sleep memory".to_string()]);
        assert_eq!(req.top, default_dup_top());
        assert_eq!(req.candidates, default_dup_candidates());
    }

    #[test]
    fn duplicate_scan_request_honours_explicit_top_and_candidates() {
        let line =
            r#"{"kind":"duplicate-scan","queries":["q"],"top":3,"candidates":9,"schema_version":1}"#;
        let req: DuplicateScanRequest = serde_json::from_str(line).expect("dup-scan request parses");
        assert_eq!(req.top, 3);
        assert_eq!(req.candidates, 9);
    }

    /// A scan after a reindex must see the reindex. The cache is rebuilt only
    /// when `data_version` moves, and it moves only for a connection that
    /// stayed open across the write.
    #[test]
    fn the_cached_context_picks_up_a_note_written_after_it_was_built() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("index.db");
        let writer = crate::db::open_or_create_db(&db_path.to_string_lossy()).unwrap();
        let add_note = |path: &str| {
            writer
                .execute(
                    "INSERT INTO notes (path, title, content_hash, mtime) VALUES (?1, ?1, 'hash', 0.0)",
                    [path],
                )
                .unwrap();
            let blob: Vec<u8> = [1.0f32, 0.0, 0.0].iter().flat_map(|f| f.to_le_bytes()).collect();
            writer
                .execute(
                    "INSERT INTO embeddings (id, data) SELECT id, ?2 FROM notes WHERE path = ?1",
                    rusqlite::params![path, blob],
                )
                .unwrap();
        };
        add_note("a.md");

        let index = ScanIndex::new(db_path);
        let first = index.search_context().unwrap();
        assert_eq!(first.store.len(), 1);
        assert!(Arc::ptr_eq(&first, &index.search_context().unwrap()), "unchanged, so cached");

        add_note("b.md");
        assert_eq!(index.search_context().unwrap().store.len(), 2);
    }

    #[test]
    fn protocol_error_carries_schema_version() {
        let payload = protocol_error("boom".to_string());
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("protocol error is valid JSON");
        assert_eq!(parsed["schema_version"], PROTOCOL_SCHEMA_VERSION);
        assert_eq!(parsed["error"], "boom");
    }
}
