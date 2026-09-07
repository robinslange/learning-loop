//! The one base64 engine this crate encodes and decodes through.
//!
//! Every byte string on the v5 wire — statements, signatures, nonces, index
//! shas — is base64 with the standard alphabet and padding, because that is
//! what the hub reads. Which engine that is was previously restated at
//! twenty-two sites across fifteen files: all of them `STANDARD`, and
//! nothing checking that they agreed.
//!
//! **The functions are the point, not the constant.** Exposing an engine
//! would leave every call site free to declare its own and still look
//! canonical; with `encode` and `decode` there is no engine for a site to
//! name, so the agreement is structural rather than a convention somebody
//! has to keep. `sync::atomic_file` did the same thing to five fixed-temp-name
//! JSON writers, and what fixed it was one writer everything routes through
//! rather than blessing the best of the five.
//!
//! `crate_names_no_base64_engine_but_this_module` in `tests/one_base64.rs`
//! holds the sweep: no other file in this crate may name the base64 crate at
//! all. An absence checked by hand is an absence that grows back.
//!
//! The transcript is what makes the value itself load-bearing rather than a
//! preference. `sync::transcript_v5` replays sync-hub's checked-in fixture
//! through this crate's own encoder, so changing `ENGINE` here turns that
//! cross-repo test red — which was not true while the transcript compared the
//! hub's bytes against a copy of `STANDARD` declared in the test's own file.

use base64::Engine as _;

/// Deliberately private. A `pub` engine is a `pub` invitation to write
/// `ENGINE.encode(..)` at a call site, and then the next engine added beside
/// it looks equally official.
const ENGINE: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::STANDARD;

pub fn encode<T: AsRef<[u8]>>(bytes: T) -> String {
    ENGINE.encode(bytes)
}

pub fn decode<T: AsRef<[u8]>>(text: T) -> Result<Vec<u8>, base64::DecodeError> {
    ENGINE.decode(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Standard alphabet, padding on. Pinned as bytes rather than by naming
    /// the engine again, so this test disagrees with `ENGINE` rather than
    /// restating it: `URL_SAFE` renders the last two as `-_` and
    /// `STANDARD_NO_PAD` drops the `=`.
    #[test]
    fn the_engine_is_standard_with_padding() {
        assert_eq!(encode([0xfb, 0xff, 0xbe]), "+/++");
        assert_eq!(encode("a"), "YQ==");
        assert_eq!(decode("+/++").unwrap(), vec![0xfb, 0xff, 0xbe]);
        assert_eq!(decode("YQ==").unwrap(), b"a");
    }

    #[test]
    fn decode_refuses_what_it_cannot_read_rather_than_guessing() {
        assert!(decode("YQ").is_err(), "unpadded input is not this alphabet");
        assert!(decode("*").is_err());
    }
}
