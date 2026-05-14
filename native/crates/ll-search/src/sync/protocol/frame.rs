//! Binary data-plane frames: single-frame `Envelope` (v2) and per-chunk
//! `ChunkedFrame` (v3), plus the `manifest_root` over chunked frame hashes.

use sha2::{Digest, Sha256};

use crate::sync::error::SyncError;
use super::{
    CHUNKED_HEADER_LEN, CHUNK_MAX_BODY_SIZE, ENVELOPE_HEADER_LEN, MAX_ENVELOPE_SIZE,
};

/// Wire frame for an index transfer. Control plane (JSON `PeerEnvelope`) carries
/// the meta; data plane (this struct) carries the bytes. SHA256 is computed before
/// transmission and verified after receipt. Mirrors sync-hub `frame::Envelope`.
#[derive(Debug)]
pub struct Envelope {
    pub size: u32,
    pub hash: [u8; 32],
    pub body: Vec<u8>,
}

impl Envelope {
    pub fn from_body(body: Vec<u8>) -> std::result::Result<Self, SyncError> {
        if body.len() > MAX_ENVELOPE_SIZE {
            return Err(SyncError::EnvelopeOversize { cap: MAX_ENVELOPE_SIZE });
        }
        let hash: [u8; 32] = Sha256::digest(&body).into();
        let size = body.len() as u32;
        Ok(Self { size, hash, body })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(ENVELOPE_HEADER_LEN + self.body.len());
        out.extend_from_slice(&self.size.to_be_bytes());
        out.extend_from_slice(&self.hash);
        out.extend_from_slice(&self.body);
        out
    }

    pub fn decode(buf: &[u8]) -> std::result::Result<Self, SyncError> {
        if buf.len() < ENVELOPE_HEADER_LEN {
            return Err(SyncError::SizeMismatch {
                expected: ENVELOPE_HEADER_LEN,
                actual: buf.len(),
            });
        }
        let size = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]);
        if size as usize > MAX_ENVELOPE_SIZE {
            return Err(SyncError::EnvelopeOversize { cap: MAX_ENVELOPE_SIZE });
        }
        let expected = ENVELOPE_HEADER_LEN + size as usize;
        if buf.len() != expected {
            return Err(SyncError::SizeMismatch {
                expected,
                actual: buf.len(),
            });
        }
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&buf[4..ENVELOPE_HEADER_LEN]);
        let body = buf[ENVELOPE_HEADER_LEN..].to_vec();
        let computed: [u8; 32] = Sha256::digest(&body).into();
        if computed != hash {
            return Err(SyncError::HashMismatch);
        }
        Ok(Self { size, hash, body })
    }
}

/// Per-chunk frame for v3 chunked uploads. Mirrors sync-hub `frame::ChunkedFrame`.
///
/// Wire layout: `seq | total | body_size | body_sha256` (4+4+4+32 = 44 bytes).
/// Routing identity (seq, total) first, then body_size, then integrity hash.
#[derive(Debug)]
pub struct ChunkedFrame {
    pub size: u32,
    pub hash: [u8; 32],
    pub seq: u32,
    pub total: u32,
    pub body: Vec<u8>,
}

impl ChunkedFrame {
    pub fn from_body(
        seq: u32,
        total: u32,
        body: Vec<u8>,
    ) -> std::result::Result<Self, SyncError> {
        if total == 0 || seq >= total {
            return Err(SyncError::SizeMismatch {
                expected: total as usize,
                actual: seq as usize,
            });
        }
        if body.len() > CHUNK_MAX_BODY_SIZE {
            return Err(SyncError::EnvelopeOversize {
                cap: CHUNK_MAX_BODY_SIZE,
            });
        }
        let hash: [u8; 32] = Sha256::digest(&body).into();
        Ok(Self {
            size: body.len() as u32,
            hash,
            seq,
            total,
            body,
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(CHUNKED_HEADER_LEN + self.body.len());
        out.extend_from_slice(&self.seq.to_be_bytes());
        out.extend_from_slice(&self.total.to_be_bytes());
        out.extend_from_slice(&self.size.to_be_bytes());
        out.extend_from_slice(&self.hash);
        out.extend_from_slice(&self.body);
        out
    }

    pub fn decode(buf: &[u8]) -> std::result::Result<Self, SyncError> {
        if buf.len() < CHUNKED_HEADER_LEN {
            return Err(SyncError::SizeMismatch {
                expected: CHUNKED_HEADER_LEN,
                actual: buf.len(),
            });
        }
        let seq = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]);
        let total = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]);
        if total == 0 || seq >= total {
            return Err(SyncError::SizeMismatch {
                expected: total as usize,
                actual: seq as usize,
            });
        }
        let size = u32::from_be_bytes([buf[8], buf[9], buf[10], buf[11]]);
        if size as usize > CHUNK_MAX_BODY_SIZE {
            return Err(SyncError::EnvelopeOversize {
                cap: CHUNK_MAX_BODY_SIZE,
            });
        }
        let expected = CHUNKED_HEADER_LEN + size as usize;
        if buf.len() != expected {
            return Err(SyncError::SizeMismatch {
                expected,
                actual: buf.len(),
            });
        }
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&buf[12..CHUNKED_HEADER_LEN]);
        let body = buf[CHUNKED_HEADER_LEN..].to_vec();
        let computed: [u8; 32] = Sha256::digest(&body).into();
        if computed != hash {
            return Err(SyncError::HashMismatch);
        }
        Ok(Self {
            size,
            hash,
            seq,
            total,
            body,
        })
    }
}

/// Flat manifest root: sha256 of the concatenated per-chunk sha256s in seq order.
///
/// Not a merkle tree; we ship all chunk hashes alongside the upload, so a flat
/// concatenation suffices for tamper-detection. Matches BitTorrent v1
/// piece-hash-list. The envelope JSON field is still called `merkle_root` for
/// downstream tooling compatibility.
pub fn manifest_root(chunk_hashes: &[[u8; 32]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for h in chunk_hashes {
        hasher.update(h);
    }
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunked_frame_roundtrip_client_side() {
        let body = b"chunk-body".to_vec();
        let frame = ChunkedFrame::from_body(0, 3, body.clone()).unwrap();
        let bytes = frame.encode();
        assert_eq!(bytes.len(), CHUNKED_HEADER_LEN + body.len());
        let decoded = ChunkedFrame::decode(&bytes).unwrap();
        assert_eq!(decoded.body, body);
        assert_eq!(decoded.seq, 0);
        assert_eq!(decoded.total, 3);
        assert_eq!(decoded.size as usize, body.len());
    }

    #[test]
    fn chunked_frame_header_layout_is_seq_total_size_hash() {
        let body = b"x".to_vec();
        let frame = ChunkedFrame::from_body(2, 4, body).unwrap();
        let encoded = frame.encode();
        assert_eq!(u32::from_be_bytes(encoded[0..4].try_into().unwrap()), 2);
        assert_eq!(u32::from_be_bytes(encoded[4..8].try_into().unwrap()), 4);
        assert_eq!(u32::from_be_bytes(encoded[8..12].try_into().unwrap()), 1);
        let computed = Sha256::digest(b"x");
        assert_eq!(&encoded[12..44], computed.as_slice());
        assert_eq!(&encoded[44..], b"x");
    }

    #[test]
    fn chunked_frame_hash_mismatch_client_side() {
        let body = b"abc".to_vec();
        let mut bytes = ChunkedFrame::from_body(0, 1, body).unwrap().encode();
        bytes[12] ^= 0xff;
        assert!(matches!(
            ChunkedFrame::decode(&bytes),
            Err(SyncError::HashMismatch)
        ));
    }

    #[test]
    fn chunked_frame_rejects_seq_ge_total() {
        let result = ChunkedFrame::from_body(5, 5, b"x".to_vec());
        assert!(matches!(result, Err(SyncError::SizeMismatch { .. })));
    }

    #[test]
    fn chunked_frame_rejects_oversize_chunk() {
        let huge = vec![0u8; CHUNK_MAX_BODY_SIZE + 1];
        let result = ChunkedFrame::from_body(0, 1, huge);
        assert!(matches!(
            result,
            Err(SyncError::EnvelopeOversize { cap }) if cap == CHUNK_MAX_BODY_SIZE
        ));
    }

    #[test]
    fn manifest_root_matches_concatenated_hash() {
        let chunks: Vec<&[u8]> = vec![b"a", b"b", b"c"];
        let hashes: Vec<[u8; 32]> = chunks.iter().map(|c| Sha256::digest(c).into()).collect();
        let root = manifest_root(&hashes);

        let mut hasher = Sha256::new();
        for h in &hashes {
            hasher.update(h);
        }
        let expected: [u8; 32] = hasher.finalize().into();
        assert_eq!(root, expected);
    }
}
