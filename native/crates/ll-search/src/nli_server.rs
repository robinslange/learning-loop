//! UDS NLI server hosted inside `ll-search watch`.
//!
//! The hook (hooks/modules/edge-infer.mjs) connects to `<config_dir>/nli.sock`
//! and writes a single line of JSON:
//!
//!   {"premise": "...", "hypotheses": ["...", "..."]}
//!
//! and reads a single line of JSON back (matching the binary's nli-batch
//! envelope):
//!
//!   {"schema_version": 1, "results": [{...}, ...]}
//!
//! One request per connection — no keep-alive. This keeps the protocol trivial
//! and avoids head-of-line stalls if a single batch takes longer than expected.
//! The model is loaded once (lazily, on the first request) inside the daemon
//! and reused thereafter — no 233MB re-load per hook fire.
//!
//! The server is unix-only. On non-unix platforms the daemon-side wiring is
//! a no-op; the hook falls back to the existing `execFileSync` subprocess
//! path.

#![cfg(unix)]

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::watch as watch_chan;

use crate::nli::{nli_batch, NliBatchResponse};

#[derive(Deserialize)]
struct NliRequest {
    premise: String,
    hypotheses: Vec<String>,
}

#[derive(Serialize)]
struct ProtocolError {
    schema_version: u32,
    error: String,
}

/// Spawn the NLI socket server. Returns immediately; runs until `shutdown_rx`
/// flips to true. Cleans up the socket file on shutdown.
///
/// Stale socket detection: if the path already exists, attempt a quick connect
/// to it. If the connect succeeds, another daemon owns this socket and we
/// refuse to start. If the connect fails (ECONNREFUSED / ENOENT), the socket
/// is stale (previous daemon crashed without cleanup) and we unlink + rebind.
pub async fn run_nli_server(
    socket_path: PathBuf,
    mut shutdown_rx: watch_chan::Receiver<bool>,
) -> anyhow::Result<()> {
    if socket_path.exists() {
        match UnixStream::connect(&socket_path).await {
            Ok(_) => {
                anyhow::bail!(
                    "NLI socket {} is already in use by another daemon — refusing to start",
                    socket_path.display()
                );
            }
            Err(_) => {
                // Stale socket from a crashed/killed daemon. Safe to unlink.
                let _ = std::fs::remove_file(&socket_path);
            }
        }
    }

    let listener = UnixListener::bind(&socket_path)
        .map_err(|e| anyhow::anyhow!("bind NLI socket {}: {e}", socket_path.display()))?;
    // 0700 — same user only. UDS files inherit the process umask; tighten
    // explicitly so a permissive umask doesn't leak access to other users
    // on shared hosts.
    if let Err(e) = restrict_socket_permissions(&socket_path) {
        eprintln!("warning: failed to restrict NLI socket permissions: {e}");
    }
    eprintln!("NLI server listening on {}", socket_path.display());

    let socket_path_for_cleanup = socket_path.clone();
    let result = loop {
        tokio::select! {
            biased;
            _ = shutdown_rx.changed() => break Ok(()),
            accept = listener.accept() => {
                match accept {
                    Ok((stream, _addr)) => {
                        tokio::spawn(async move {
                            if let Err(e) = handle_connection(stream).await {
                                eprintln!("NLI server connection error: {e}");
                            }
                        });
                    }
                    Err(e) => {
                        eprintln!("NLI server accept error: {e}");
                        // Brief backoff to avoid tight error loops on persistent
                        // accept failures (fd exhaustion, etc.).
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                }
            }
        }
    };

    let _ = std::fs::remove_file(&socket_path_for_cleanup);
    eprintln!("NLI server stopped");
    result
}

async fn handle_connection(stream: UnixStream) -> anyhow::Result<()> {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let mut line = String::new();
    let bytes = reader.read_line(&mut line).await?;
    if bytes == 0 {
        return Ok(());
    }

    let response = match serde_json::from_str::<NliRequest>(&line) {
        Ok(req) => {
            // Inference is CPU-bound and serialised by the session mutex.
            // spawn_blocking keeps it off the tokio worker so other concurrent
            // requests (or the fs-watcher debounce) aren't starved.
            let result = tokio::task::spawn_blocking(move || nli_batch(&req.premise, &req.hypotheses))
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

fn restrict_socket_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o700);
    std::fs::set_permissions(path, perms)
}

// Suppress the unused-import warning when build_state is never called directly
// (it is called transitively via nli_batch -> classify_pair -> state()).
#[allow(dead_code)]
fn _link_check() -> NliBatchResponse {
    nli_batch("", &[])
}
