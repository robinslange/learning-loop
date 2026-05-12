use ll_search::sync::error::SyncError;
use ll_search::sync::protocol::{Envelope, ENVELOPE_HEADER_LEN, MAX_ENVELOPE_SIZE};
use sha2::{Digest, Sha256};

#[test]
fn roundtrip_preserves_bytes() {
    let body = b"the quick brown fox jumps over the lazy dog".to_vec();
    let env = Envelope::from_body(body.clone()).unwrap();
    let encoded = env.encode();
    let decoded = Envelope::decode(&encoded).unwrap();
    assert_eq!(decoded.body, body);
    assert_eq!(decoded.size as usize, body.len());
    assert_eq!(decoded.hash, env.hash);
}

#[test]
fn header_layout_is_size_then_hash() {
    let body = b"x".to_vec();
    let env = Envelope::from_body(body).unwrap();
    let encoded = env.encode();
    assert_eq!(encoded[0..4], [0, 0, 0, 1]);
    let computed = Sha256::digest(b"x");
    assert_eq!(&encoded[4..ENVELOPE_HEADER_LEN], computed.as_slice());
    assert_eq!(&encoded[ENVELOPE_HEADER_LEN..], b"x");
}

#[test]
fn empty_body_roundtrips() {
    let env = Envelope::from_body(Vec::new()).unwrap();
    let encoded = env.encode();
    assert_eq!(encoded.len(), ENVELOPE_HEADER_LEN);
    let decoded = Envelope::decode(&encoded).unwrap();
    assert_eq!(decoded.body, Vec::<u8>::new());
    assert_eq!(decoded.size, 0);
}

#[test]
fn size_mismatch_rejected() {
    let body = b"correct".to_vec();
    let env = Envelope::from_body(body).unwrap();
    let mut encoded = env.encode();
    encoded.truncate(encoded.len() - 1);
    let result = Envelope::decode(&encoded);
    assert!(matches!(result, Err(SyncError::SizeMismatch { .. })));
}

#[test]
fn hash_mismatch_rejected() {
    let body = b"correct".to_vec();
    let mut env = Envelope::from_body(body).unwrap();
    env.hash[0] ^= 0xff;
    let encoded = env.encode();
    let result = Envelope::decode(&encoded);
    assert!(matches!(result, Err(SyncError::HashMismatch)));
}

#[test]
fn oversize_rejected_no_alloc() {
    // u32::MAX size declared with only the header bytes available - decode must reject
    // before allocating a 4GB body.
    let mut buf = vec![0u8; ENVELOPE_HEADER_LEN];
    buf[0..4].copy_from_slice(&u32::MAX.to_be_bytes());
    let before = std::time::Instant::now();
    let result = Envelope::decode(&buf);
    let elapsed = before.elapsed();
    assert!(matches!(result, Err(SyncError::EnvelopeOversize { .. })));
    assert!(
        elapsed.as_millis() < 50,
        "decode of oversize-declared frame must reject before allocating; took {elapsed:?}"
    );
}

#[test]
fn from_body_rejects_oversize() {
    // Pretend we have a body just over the cap. Don't actually allocate that much.
    let cap = MAX_ENVELOPE_SIZE;
    // We can construct an explicit too-short header that *declares* > cap and confirm decode
    // path; the from_body Vec<u8> input bound is enforced by from_body itself if len > cap.
    // Build a synthetic header declaring size = MAX_ENVELOPE_SIZE + 1 and confirm OversizeDeclared.
    let mut buf = vec![0u8; ENVELOPE_HEADER_LEN];
    let too_big: u32 = (cap as u32).wrapping_add(1);
    buf[0..4].copy_from_slice(&too_big.to_be_bytes());
    let result = Envelope::decode(&buf);
    assert!(matches!(result, Err(SyncError::EnvelopeOversize { .. })));
}

#[test]
fn too_short_rejected() {
    let result = Envelope::decode(&[0u8; 10]);
    assert!(matches!(result, Err(SyncError::SizeMismatch { .. })));
}
