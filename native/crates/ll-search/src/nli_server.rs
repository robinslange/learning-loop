//! UDS server hosted inside `ll-search watch`.
//!
//! Wire contract (line-delimited JSON, one request per connection — no keep-alive).
//! Requests are distinguished by their shape (additive, so old clients are
//! unaffected): a request carrying `premise`/`hypotheses` is an NLI batch; one
//! carrying `kind: "duplicate-scan"` is a reflect-style duplicate scan.
//!
//!   NLI request:    {"premise": "...", "hypotheses": ["...", "..."], "schema_version": 1 (optional)}\n
//!   NLI response:   {"schema_version": 1, "results": [{...}, ...]}\n
//!
//!   Dup request:    {"kind": "duplicate-scan", "queries": ["..."], "top": 1, "candidates": 5, "schema_version": 1 (optional)}\n
//!   Dup response:   {"schema_version": 1, "queries": [{...}], "confusable_pairs": [...]}\n
//!
//!   Error:          {"schema_version": 1, "error": "..."}\n
//!
//! Both the NLI model and the embedding model are loaded once (lazily, on the
//! first request that needs them) inside the daemon and reused thereafter — no
//! per-hook-fire re-load.
//!
//! The server is unix-only. On non-unix platforms the daemon-side wiring is
//! a no-op; the hook falls back to the existing `execFileSync` subprocess
//! path.

#![cfg(unix)]

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::watch as watch_chan;
use tokio::task::JoinSet;

use crate::nli::nli_batch;

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

/// One request per connection. The variant is chosen by JSON shape so the
/// wire protocol extends additively: an NLI client that never sends `kind`
/// keeps working unchanged. `#[serde(untagged)]` tries each variant in order;
/// `Nli` (with its required `hypotheses`) is tried first, then the
/// `kind`-tagged `DuplicateScan`.
#[derive(Deserialize)]
#[serde(untagged)]
enum Request {
    Nli(NliRequest),
    DuplicateScan(DuplicateScanRequest),
}

#[derive(Deserialize)]
struct NliRequest {
    premise: String,
    hypotheses: Vec<String>,
    /// Optional — clients on the same major schema can omit it. Future
    /// daemon revisions could reject mismatched versions instead of
    /// silently downgrading.
    #[serde(default)]
    #[allow(dead_code)]
    schema_version: Option<u32>,
}

fn default_dup_top() -> usize {
    1
}

fn default_dup_candidates() -> usize {
    5
}

#[derive(Deserialize)]
struct DuplicateScanRequest {
    /// Discriminant — must equal `"duplicate-scan"`. Untagged deserialization
    /// alone can't distinguish this from a future request that also omits
    /// `hypotheses`, so the handler asserts the value before dispatching.
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
/// `db_path` is the search index the daemon already maintains; duplicate-scan
/// requests open a fresh read connection against it per request (SQLite is
/// thread-safe in this mode and the embedding model is shared via the global
/// provider). NLI requests don't touch it.
pub async fn run_nli_server(
    socket_path: PathBuf,
    db_path: PathBuf,
    mut shutdown_rx: watch_chan::Receiver<bool>,
) -> anyhow::Result<()> {
    let db_path = Arc::new(db_path);
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
                    "NLI socket {} is already in use by another daemon — refusing to start",
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
        .map_err(|e| anyhow::anyhow!("bind NLI socket {}: {e}", socket_path.display()))?;
    // 0700 — same user only. UDS files inherit the process umask; tighten
    // explicitly so a permissive umask doesn't leak access to other users
    // on shared hosts. Window between bind() and chmod is accepted (local
    // single-user trust model).
    if let Err(e) = restrict_socket_permissions(&socket_path) {
        eprintln!("warning: failed to restrict NLI socket permissions: {e}");
    }
    eprintln!("NLI server listening on {}", socket_path.display());

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
                        eprintln!("NLI server handler panicked: {e}");
                    }
                }
            }
            accept = listener.accept() => {
                match accept {
                    Ok((stream, _addr)) => {
                        let db_path = Arc::clone(&db_path);
                        handlers.spawn(async move {
                            if let Err(e) = handle_connection(stream, db_path).await {
                                eprintln!("NLI server connection error: {e}");
                            }
                        });
                    }
                    Err(e) => {
                        eprintln!("NLI server accept error: {e}");
                        // Brief backoff to avoid tight error loops on persistent
                        // accept failures (fd exhaustion, etc.).
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
            }
        }
    };

    eprintln!(
        "NLI server: draining {} in-flight handlers (timeout {}s)",
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
            "NLI server: {leftover} handler(s) still running after drain — aborting",
        );
        handlers.abort_all();
    }

    let _ = std::fs::remove_file(&socket_path_for_cleanup);
    eprintln!("NLI server stopped");
    result
}

async fn handle_connection(stream: UnixStream, db_path: Arc<PathBuf>) -> anyhow::Result<()> {
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

    let response = match serde_json::from_str::<Request>(&line) {
        Ok(Request::Nli(req)) => {
            // Inference is CPU-bound and serialised by the session mutex.
            // spawn_blocking keeps it off the tokio worker so other concurrent
            // requests (or the fs-watcher debounce) aren't starved.
            let result =
                tokio::task::spawn_blocking(move || nli_batch(&req.premise, &req.hypotheses))
                    .await;
            match result {
                Ok(batch) => serde_json::to_string(&batch)
                    .unwrap_or_else(|e| protocol_error(format!("serialize response: {e}"))),
                Err(join_err) => protocol_error(format!("inference task panicked: {join_err}")),
            }
        }
        Ok(Request::DuplicateScan(req)) => {
            if req.kind != "duplicate-scan" {
                protocol_error(format!("unknown request kind: {}", req.kind))
            } else {
                // Same shape as `reflect-scan`: open a read connection against
                // the daemon's index, run the scan with the warm embedding +
                // rerank models, and return the reflect envelope. spawn_blocking
                // keeps the SQLite + ONNX work off the tokio worker.
                let result = tokio::task::spawn_blocking(move || run_duplicate_scan(&db_path, &req))
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

/// Run a reflect-style duplicate scan against the daemon's index, reusing the
/// same `reflect_scan` pipeline the `reflect-scan` CLI command calls. The
/// embedding provider is lazily initialised the same way the NLI model is —
/// on first use, then reused for the daemon's lifetime — so a duplicate-scan
/// request never re-loads the model.
fn run_duplicate_scan(
    db_path: &Path,
    req: &DuplicateScanRequest,
) -> anyhow::Result<crate::search::ReflectScanResult> {
    // Lazy, idempotent: the embedding provider is a global OnceLock, so the
    // first scan pays the load cost and subsequent scans reuse it. init is a
    // no-op when already initialised with the same model.
    crate::embed::init_provider(&crate::model::KnownModel::BgeSmallEnV15);

    let db_str = db_path.to_string_lossy();
    let conn = crate::db::open_db(&db_str)
        .map_err(|e| anyhow::anyhow!("open index {}: {e:#}", db_path.display()))?;
    let store = crate::search::load_store(&conn);
    Ok(crate::search::reflect_scan(
        &conn,
        &req.queries,
        req.top,
        req.candidates,
        DUPLICATE_SCAN_DISCRIMINATE_THRESHOLD,
        &store,
    ))
}

fn protocol_error(message: String) -> String {
    serde_json::to_string(&ProtocolError {
        schema_version: crate::nli::NLI_SCHEMA_VERSION,
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

    // Wire-protocol routing: the untagged `Request` enum must classify a
    // request by shape, additively, so old NLI clients keep working after the
    // duplicate-scan variant was added.

    #[test]
    fn nli_shaped_request_routes_to_nli() {
        let line = r#"{"premise":"a","hypotheses":["b","c"],"schema_version":1}"#;
        match serde_json::from_str::<Request>(line).expect("NLI request parses") {
            Request::Nli(req) => {
                assert_eq!(req.premise, "a");
                assert_eq!(req.hypotheses, vec!["b".to_string(), "c".to_string()]);
            }
            Request::DuplicateScan(_) => panic!("NLI request misrouted to duplicate-scan"),
        }
    }

    #[test]
    fn nli_request_without_schema_version_still_routes_to_nli() {
        // Old clients omit schema_version entirely — must not flip to the
        // duplicate-scan variant.
        let line = r#"{"premise":"a","hypotheses":["b"]}"#;
        assert!(matches!(
            serde_json::from_str::<Request>(line).expect("legacy NLI request parses"),
            Request::Nli(_)
        ));
    }

    #[test]
    fn duplicate_scan_request_routes_with_defaults() {
        let line = r#"{"kind":"duplicate-scan","queries":["sleep memory"]}"#;
        match serde_json::from_str::<Request>(line).expect("dup-scan request parses") {
            Request::DuplicateScan(req) => {
                assert_eq!(req.kind, "duplicate-scan");
                assert_eq!(req.queries, vec!["sleep memory".to_string()]);
                assert_eq!(req.top, default_dup_top());
                assert_eq!(req.candidates, default_dup_candidates());
            }
            Request::Nli(_) => panic!("duplicate-scan request misrouted to NLI"),
        }
    }

    #[test]
    fn duplicate_scan_request_honours_explicit_top_and_candidates() {
        let line =
            r#"{"kind":"duplicate-scan","queries":["q"],"top":3,"candidates":9,"schema_version":1}"#;
        match serde_json::from_str::<Request>(line).expect("dup-scan request parses") {
            Request::DuplicateScan(req) => {
                assert_eq!(req.top, 3);
                assert_eq!(req.candidates, 9);
            }
            Request::Nli(_) => panic!("duplicate-scan request misrouted to NLI"),
        }
    }

    #[test]
    fn protocol_error_carries_schema_version() {
        let payload = protocol_error("boom".to_string());
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("protocol error is valid JSON");
        assert_eq!(parsed["schema_version"], crate::nli::NLI_SCHEMA_VERSION);
        assert_eq!(parsed["error"], "boom");
    }
}
