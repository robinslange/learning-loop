//! Sync protocol surface: cross-cutting constants and re-exports of the
//! control-plane messages (`messages`), data-plane frames (`frame`), and
//! wire timestamp (`time`).

mod frame;
mod messages;
mod time;

pub use frame::{manifest_root, ChunkedFrame, Envelope};
pub use messages::{ClientMessage, EnvelopeMeta, HubMessage, PeerInfo};
pub use time::PeerTimestamp;

/// Maximum envelope size accepted on either send or receive.
///
/// This is the **client-side policy ceiling**; the hub's axum
/// `WebSocketUpgrade::max_message_size` is the lower effective ceiling
/// for outbound uploads (see [`HUB_INBOUND_CAP`]).
pub const MAX_ENVELOPE_SIZE: usize = 200 * 1024 * 1024;

/// Bytes preceding the body in a framed binary message: 4 (size BE u32) + 32 (sha256).
pub const ENVELOPE_HEADER_LEN: usize = 4 + 32;

/// Hub's axum `WebSocketUpgrade::max_message_size`. Uploads above this are dropped
/// at the transport layer; pre-flight returns [`crate::sync::error::SyncError::EnvelopeOversize`].
pub const HUB_INBOUND_CAP: usize = 50 * 1024 * 1024;

/// Protocol version this client advertises in `SyncHello`.
pub const PROTOCOL_VERSION_FRAMED: u32 = 2;

/// Protocol version that introduces chunked + body-kind + body-encoding uploads.
pub const PROTOCOL_VERSION_CHUNKED: u32 = 3;

/// Latest protocol version this client knows how to speak. Sent in `SyncHello`;
/// the hub negotiates down via `min(client, server)`.
pub const PROTOCOL_VERSION_LATEST: u32 = PROTOCOL_VERSION_CHUNKED;

/// Bytes preceding the body in a v3 chunked binary message:
/// 4 (seq BE u32) + 4 (total BE u32) + 4 (body_size BE u32) + 32 (sha256).
pub const CHUNKED_HEADER_LEN: usize = 4 + 4 + 4 + 32;

/// Per-chunk frame ceiling. 8 MiB stays under tokio-tungstenite's 16 MiB
/// `max_frame_size` default so chunked uploads don't need that ceiling raised.
pub const CHUNK_MAX_BODY_SIZE: usize = 8 * 1024 * 1024;
