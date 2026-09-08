use std::time::Duration;

/// Typed error returned by the async sync paths in `client.rs` and `watch.rs`.
///
/// Cancellation safety note (track 2J R1): tokio-tungstenite's `StreamExt::next`
/// is cancel-safe at the *frame* boundary. `tokio::time::timeout(..., ws.next())`
/// cancelling mid-frame loses that frame, but subsequent reads on the same stream
/// remain well-formed. Tests in `sync_recv_timeout.rs` exercise this directly.
#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("recv timed out after {timeout:?}")]
    RecvTimeout { timeout: Duration },
    #[error("send timed out after {timeout:?}")]
    SendTimeout { timeout: Duration },
    #[error("envelope size mismatch: expected {expected}, got {actual}")]
    SizeMismatch { expected: usize, actual: usize },
    #[error("envelope sha256 mismatch")]
    HashMismatch,
    #[error("envelope exceeds hard cap {cap} bytes")]
    EnvelopeOversize { cap: usize },
    #[error("websocket closed unexpectedly")]
    ClosedUnexpected,
    #[error("non-binary frame received where binary expected")]
    FrameKind,
    #[error("ws: {0}")]
    Ws(#[from] tokio_tungstenite::tungstenite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

impl SyncError {
    /// Whether retrying this on a timer is knowably pointless.
    ///
    /// Deliberately narrow. A dropped connection, a timeout, a hub that was
    /// restarting -- all of those are worth another cycle, and calling them
    /// terminal would stop a vault syncing over a blip. Only an export that
    /// cannot fit in one frame qualifies today: it does not shrink because
    /// time passed, so the next attempt is the same attempt.
    ///
    /// Takes `anyhow::Error` because the sync paths wrap these with context
    /// and the classification must survive that wrapping.
    pub fn is_terminal(err: &anyhow::Error) -> bool {
        matches!(
            err.downcast_ref::<SyncError>(),
            Some(SyncError::EnvelopeOversize { .. })
        )
    }
}

pub type Result<T> = std::result::Result<T, SyncError>;
