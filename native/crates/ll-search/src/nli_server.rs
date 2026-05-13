//! UDS NLI server hosted inside `ll-search watch`.
//!
//! Wire contract (line-delimited JSON, one request per connection — no keep-alive):
//!
//!   Request:  {"premise": "...", "hypotheses": ["...", "..."], "schema_version": 1 (optional)}\n
//!   Response: {"schema_version": 1, "results": [{...}, ...]}\n
//!   Error:    {"schema_version": 1, "error": "..."}\n
//!
//! The model is loaded once (lazily, on the first request) inside the daemon
//! and reused thereafter — no 233MB re-load per hook fire.
//!
//! The server is unix-only. On non-unix platforms the daemon-side wiring is
//! a no-op; the hook falls back to the existing `execFileSync` subprocess
//! path.

#![cfg(unix)]

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::watch as watch_chan;
use tokio::task::JoinSet;

use crate::nli::nli_batch;

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

#[derive(Serialize)]
struct ProtocolError {
    schema_version: u32,
    error: String,
}

/// Spawn the NLI socket server. Returns immediately; runs until `shutdown_rx`
/// flips to true. Cleans up the socket file on shutdown and drains in-flight
/// handlers within `SHUTDOWN_DRAIN`.
pub async fn run_nli_server(
    socket_path: PathBuf,
    mut shutdown_rx: watch_chan::Receiver<bool>,
) -> anyhow::Result<()> {
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
                        handlers.spawn(async move {
                            if let Err(e) = handle_connection(stream).await {
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

async fn handle_connection(stream: UnixStream) -> anyhow::Result<()> {
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

    let response = match serde_json::from_str::<NliRequest>(&line) {
        Ok(req) => {
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
        Err(parse_err) => protocol_error(format!("parse request: {parse_err}")),
    };

    write_half.write_all(response.as_bytes()).await?;
    write_half.write_all(b"\n").await?;
    write_half.flush().await?;
    Ok(())
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
