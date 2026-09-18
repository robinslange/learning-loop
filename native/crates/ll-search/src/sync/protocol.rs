//! Sync protocol surface: cross-cutting constants and the data-plane
//! frames (`frame`).
//!
//! The v2/v3 JSON control plane that sat beside them is gone. `protocol_v5`
//! is the only control plane this client speaks, and `messages.rs` was the
//! last place it still knew the word `sync-reject` — a tag no v5 consumer can
//! decode, kept alive by nothing but its own tests.

mod frame;

pub use frame::{manifest_root, ChunkedFrame, Envelope};

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

/// The largest single WebSocket frame payload this client will READ.
///
/// The mirror of [`HUB_INBOUND_CAP`], and it had no name because nothing set
/// it: the connection was opened with `connect_async_tls_with_config(.., None,
/// ..)`, so the receive ceiling was whatever tungstenite defaulted to -- a
/// limit this client depended on, documented nowhere, and never stated beside
/// the send limit it has to agree with.
///
/// Named and passed explicitly now. Equal to the send cap on purpose: the two
/// bound the same frame travelling in opposite directions, and a client that
/// refuses to send what it is willing to receive (or the reverse) is a
/// disagreement waiting for a vault to grow into it.
pub const HUB_INBOUND_FRAME_CAP: usize = HUB_INBOUND_CAP;

/// Bytes preceding the body in a v3 chunked binary message:
/// 4 (seq BE u32) + 4 (total BE u32) + 4 (body_size BE u32) + 32 (sha256).
pub const CHUNKED_HEADER_LEN: usize = 4 + 4 + 4 + 32;

/// Per-chunk frame ceiling. 8 MiB stays under tokio-tungstenite's 16 MiB
/// `max_frame_size` default so chunked uploads don't need that ceiling raised.
pub const CHUNK_MAX_BODY_SIZE: usize = 8 * 1024 * 1024;

/// Upper bound on the frame count a hub may claim in a `ChunkedBody`.
///
/// `chunks` is the one number in the descriptor that is acted on before any
/// frame is read, and it sized a `Vec::with_capacity`. A hub sending
/// `chunks: u32::MAX` requests four billion 32-byte hashes, ~128 GiB, from a
/// number it chose, with no body sent and none required. The send path clamps
/// against [`CHUNK_MAX_BODY_SIZE`] and the hub's `max_total_bytes`; the receive
/// path had no counterpart, which is the asymmetry rather than the size.
///
/// What an unbounded request does is allocator- and platform-dependent, so the
/// test asserts the part that is not: without this cap the client accepts the
/// descriptor and blocks in the frame loop on frames the hub never has to send,
/// measured at 30s against 0.00s. Refusing on the descriptor alone is the
/// behaviour, and a hub pinning a client that way costs it nothing.
///
/// 4096 frames at the 8 MiB ceiling describes a 32 GiB body, two orders above
/// the 200 MiB hubs advertise as `max_total_bytes`, so this refuses only
/// descriptors that were never going to reassemble into anything.
pub const MAX_CHUNKS: u32 = 4096;
