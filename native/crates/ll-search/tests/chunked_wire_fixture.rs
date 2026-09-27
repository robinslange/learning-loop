//! CROSS-REPO WIRE FIXTURE — the client's half.
//!
//! `tests/fixtures/chunked-upload-v3.wire` is vendored byte-for-byte into both
//! this repo and sync-hub's `tests/fixtures/`. Neither repo can see the other,
//! so `FIXTURE_SHA256` below is the contract: it is asserted with the same
//! literal on both sides, and a wire change made on only one side reddens that
//! side rather than silently breaking uploads while both halves still compile.
//!
//! It goes further than the `manifest_root_is_a_flat_sha256_of_chunk_hashes`
//! twin test, which pins one hash. This pins the whole frame layout — field
//! order, endianness, header width, hash position — from both directions: the
//! client must decode frames it did not produce, and must produce the exact
//! bytes the fixture holds from the same body.
//!
//! The fixture was produced by a third implementation (a short Python script),
//! so agreeing with it is evidence about the protocol, not about either repo's
//! own code agreeing with itself.

use ll_search::sync::protocol::{chunked_frames, manifest_root, ChunkedFrame};
use sha2::{Digest, Sha256};

/// Changing this without changing sync-hub's copy in the same breath is the
/// mistake this whole file exists to make loud.
const FIXTURE_SHA256: &str = "7fb57a67a59dee0809cd53c4b27b4579de880428df3dfe905f3c5bc3100e4c8e";

/// The fixture's stated shape, restated here so a fixture that quietly changed
/// its own parameters cannot keep every assertion below true.
const FIXTURE_BODY_LEN: usize = 2500;
const FIXTURE_CHUNK_BYTES: usize = 1000;

struct Fixture {
    body_sha256: String,
    chunks: u32,
    frames: Vec<Vec<u8>>,
    manifest_root: [u8; 32],
}

fn load() -> Fixture {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/chunked-upload-v3.wire"
    );
    let raw = std::fs::read(path).expect("wire fixture is committed alongside this test");
    assert_eq!(
        hex::encode(Sha256::digest(&raw)),
        FIXTURE_SHA256,
        "the vendored fixture no longer matches the pinned digest — either this \
         copy drifted, or the wire format changed and sync-hub's copy and \
         literal must change with it"
    );

    let text = String::from_utf8(raw).expect("fixture is utf-8");
    let mut body_sha256 = String::new();
    let mut chunks = 0u32;
    let mut frames: Vec<(u32, Vec<u8>)> = Vec::new();
    let mut manifest = [0u8; 32];

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        match parts.next().expect("a non-empty line has a key") {
            "body-sha256" => body_sha256 = parts.next().expect("body-sha256 value").to_string(),
            "chunks" => chunks = parts.next().expect("chunks value").parse().expect("u32"),
            "chunk" => {
                let seq: u32 = parts.next().expect("chunk seq").parse().expect("u32");
                let bytes = hex::decode(parts.next().expect("chunk hex")).expect("hex");
                frames.push((seq, bytes));
            }
            "manifest-root" => manifest
                .copy_from_slice(&hex::decode(parts.next().expect("root hex")).expect("hex")),
            other => panic!("unknown fixture key {other}"),
        }
    }

    frames.sort_by_key(|(seq, _)| *seq);
    assert_eq!(
        frames.len() as u32,
        chunks,
        "fixture declares its own frame count"
    );
    Fixture {
        body_sha256,
        chunks,
        frames: frames.into_iter().map(|(_, b)| b).collect(),
        manifest_root: manifest,
    }
}

/// The body the fixture was cut from, rebuilt from its stated rule rather than
/// read back out of the frames — otherwise the producer test below would be
/// checking the encoder against its own output.
fn fixture_body() -> Vec<u8> {
    (0..FIXTURE_BODY_LEN).map(|i| (i % 251) as u8).collect()
}

/// The client must read frames it did not write, and write them back unchanged.
#[test]
fn the_client_decodes_and_reproduces_every_frame_in_the_fixture() {
    let f = load();
    for (seq, bytes) in f.frames.iter().enumerate() {
        let frame = ChunkedFrame::decode(bytes)
            .unwrap_or_else(|e| panic!("frame {seq} must decode: {e:?}"));
        assert_eq!(frame.seq, seq as u32);
        assert_eq!(frame.total, f.chunks);
        assert_eq!(frame.size as usize, frame.body.len());
        assert_eq!(
            &frame.encode(),
            bytes,
            "frame {seq} must re-encode to the exact bytes it was decoded from"
        );
    }
}

/// The direction that matters in production: this client is the one that
/// *sends* chunks. `chunked_frames` is what the upload loop sends, so the
/// frames it cuts from the same body must be the fixture's bytes, not merely
/// bytes this client can read back.
#[test]
fn the_client_produces_the_fixtures_bytes_from_the_same_body() {
    let f = load();
    let body = fixture_body();
    assert_eq!(
        hex::encode(Sha256::digest(&body)),
        f.body_sha256,
        "the rule this test rebuilds the body from is the one the fixture used"
    );

    let frames: Vec<ChunkedFrame> = chunked_frames(&body, FIXTURE_CHUNK_BYTES)
        .collect::<Result<_, _>>()
        .expect("every chunk is within the frame ceiling");
    assert_eq!(frames.len() as u32, f.chunks);
    for (seq, frame) in frames.iter().enumerate() {
        assert_eq!(
            &frame.encode(),
            &f.frames[seq],
            "frame {seq} encoded by this client must be the bytes the hub is \
             pinned against"
        );
    }
}

/// The manifest root through this client's production function, over hashes
/// taken from the fixture's own frames.
#[test]
fn the_manifest_root_over_the_fixtures_chunks_is_the_pinned_root() {
    let f = load();
    let hashes: Vec<[u8; 32]> = f
        .frames
        .iter()
        .map(|b| ChunkedFrame::decode(b).expect("frame decodes").hash)
        .collect();
    assert_eq!(manifest_root(&hashes), f.manifest_root);
}
