//! Sync protocol surface: cross-cutting constants and re-exports of the
//! control-plane messages (`messages`) and data-plane frames (`frame`).

mod frame;
mod messages;

pub use frame::{manifest_root, ChunkedFrame, Envelope};
pub use messages::{ClientMessage, HubMessage};

/// Maximum envelope size accepted on either send or receive.
///
/// This is the **client-side policy ceiling**, and it is far above what the
/// transport can carry: [`HUB_INBOUND_CAP`] is the effective ceiling for
/// outbound uploads, and nothing this large can reach either direction.
pub const MAX_ENVELOPE_SIZE: usize = 200 * 1024 * 1024;

/// Bytes preceding the body in a framed binary message: 4 (size BE u32) + 32 (sha256).
pub const ENVELOPE_HEADER_LEN: usize = 4 + 32;

/// The largest single WebSocket frame payload the hub will read.
///
/// This is `max_frame_size`, not `max_message_size`. An unfragmented frame is
/// bounded by the former, and tungstenite and axum both default it to 16 MiB;
/// raising `max_message_size` alone -- the obvious hub-side change -- does not
/// move it. Measured against a live server: 16777216 is accepted, 16777217
/// closes the connection. Uploads above this are dropped at the transport
/// layer; pre-flight returns [`crate::sync::error::SyncError::EnvelopeOversize`].
pub const HUB_INBOUND_CAP: usize = 16 * 1024 * 1024;

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
