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
    #[error("invalid peer timestamp {raw:?}")]
    BadTimestamp { raw: String },
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

pub type Result<T> = std::result::Result<T, SyncError>;
