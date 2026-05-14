//! Client-side zstd encoding for v3 body uploads.
//!
//! Mirrored on the hub side at `sync-hub/src/compression.rs`. Compresses the
//! body (full export or patchset blob) BEFORE splitting into chunks so the
//! dictionary context spans the whole payload — per-chunk compression would
//! cost 10-15% of the ratio.

use std::io::Write;

use anyhow::Context;
use zstd::stream::write::Encoder;

/// zstd compression level. Level 3 trades ~5% ratio vs higher levels for
/// 10x faster encode; on our 16 MiB SQLite payload that's roughly 50-100 ms
/// vs several hundred ms at level 9.
pub const ZSTD_LEVEL: i32 = 3;

/// Encode `plain` to a zstd frame at [`ZSTD_LEVEL`]. Returns the compressed
/// bytes; the caller is responsible for the on-wire framing + chunking.
pub fn zstd_encode(plain: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut enc = Encoder::new(Vec::new(), ZSTD_LEVEL).context("zstd encoder init")?;
    enc.write_all(plain).context("zstd encode write")?;
    let out = enc.finish().context("zstd encode finish")?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zstd::stream::read::Decoder;
    use std::io::Read;

    fn zstd_decode(compressed: &[u8]) -> Vec<u8> {
        let mut dec = Decoder::new(compressed).unwrap();
        let mut out = Vec::new();
        dec.read_to_end(&mut out).unwrap();
        out
    }

    #[test]
    fn round_trip_text_payload() {
        let plain = b"the quick brown fox jumps over the lazy dog ".repeat(500);
        let compressed = zstd_encode(&plain).unwrap();
        assert!(
            compressed.len() < plain.len() / 5,
            "highly repetitive text should compress 5x or better, got {} -> {}",
            plain.len(),
            compressed.len()
        );
        assert_eq!(zstd_decode(&compressed), plain);
    }

    #[test]
    fn round_trip_empty_payload() {
        let compressed = zstd_encode(&[]).unwrap();
        assert_eq!(zstd_decode(&compressed), Vec::<u8>::new());
    }

    #[test]
    fn output_starts_with_zstd_magic() {
        // zstd magic number: 0x28 0xB5 0x2F 0xFD (little-endian 0xFD2FB528).
        let plain = b"x".repeat(100);
        let compressed = zstd_encode(&plain).unwrap();
        assert_eq!(&compressed[..4], &[0x28, 0xB5, 0x2F, 0xFD]);
    }
}
