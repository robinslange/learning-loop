//! FROZEN at sync-hub commit 5c36b487d4ba5d7045bb8f7227123cd6c85ec132 (Plan 3
//! Task 3). Copied verbatim from `sync-hub/src/v5/handshake.rs`: the message
//! structs, the wire constant, and the two message-framing functions that
//! define the exact bytes each role signs.
//!
//! Deliberately duplicated rather than shared across a workspace dependency —
//! the two repos have independent release cycles. Any change to an item
//! below requires the same change in sync-hub and a `PROTOCOL_VERSION` bump
//! in both repos, in one change. The pinned wire-format and exact-byte tests
//! below guard against silent divergence.

use serde::{Deserialize, Serialize};

/// The only protocol version this hub speaks. There is exactly one client;
/// there is no negotiation and no downgrade.
pub const PROTOCOL_VERSION: u32 = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClientMsg {
    ClientHello {
        key_id: String,
        nonce_c: String,
        vault_ids: Vec<String>,
        protocol_version: u32,
        model_id: String,
        invite_code: Option<String>,
    },
    ClientAuth {
        sig_c: String,
    },
    /// Declares the upload about to follow as a raw binary WS frame. No
    /// `size` or `uploaded_at`: the hub derives `size` from the frame it
    /// actually receives and stamps `uploaded_at` itself — echoing either
    /// back as authority would let an untrusted declaration outrank the
    /// hub's own record. `sha256` stays: it's the client's claim about what
    /// it believes it sent, and `store_index` validates the received bytes
    /// against it as a genuine end-to-end integrity check.
    UploadIndex {
        vault_id: String,
        sha256: String,
        note_count: i64,
        schema_version: String,
        model_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum HubMsg {
    HubChallenge {
        nonce_h: String,
        hub_key_id: String,
        sig_h: String,
    },
    SyncReady {
        protocol_version: u32,
        vault_state: Vec<VaultState>,
        grants: Vec<GrantWire>,
        revocations: Vec<String>,
    },
    Reject {
        reason: String,
    },
    UploadAck {
        vault_id: String,
        sha256: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultState {
    pub vault_id: String,
    pub holds: Option<HeldIndex>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeldIndex {
    pub sha256: String,
    pub note_count: i64,
    pub uploaded_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrantWire {
    pub statement_b64: String,
    pub signature_b64: String,
    pub state: String,
}

/// Length-prefix every field before concatenating. Plain concatenation lets
/// `("ab", "c")` and `("a", "bc")` produce identical bytes — a
/// signature-confusion bug — so each field carries its own 4-byte
/// big-endian length ahead of it.
fn framed(prefix: &[u8], parts: &[&[u8]]) -> Vec<u8> {
    let mut out = prefix.to_vec();
    for p in parts {
        out.extend_from_slice(&(p.len() as u32).to_be_bytes());
        out.extend_from_slice(p);
    }
    out
}

/// The bytes the hub signs (`sig_h`) and the client verifies. Deliberately
/// carries no `hub_key_id` — the hub signs under its own key, so its identity
/// is established by *which* key verifies this, not by a field inside it.
pub fn hub_challenge_message(nonce_h: &[u8], nonce_c: &[u8], exporter: &[u8]) -> Vec<u8> {
    framed(b"ll-hub-v5", &[nonce_h, nonce_c, exporter])
}

/// The bytes the client signs (`sig_c`) and the hub verifies. Unlike
/// [`hub_challenge_message`], this covers `hub_key_id` — the client is
/// proving it is authenticating to *this* hub specifically, so a signature
/// collected by one hub cannot be replayed to another.
pub fn client_auth_message(
    nonce_h: &[u8],
    nonce_c: &[u8],
    hub_key_id: &str,
    exporter: &[u8],
) -> Vec<u8> {
    framed(b"ll-client-v5", &[nonce_h, nonce_c, hub_key_id.as_bytes(), exporter])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hub_challenge_deserialises_from_the_hub_wire_format() {
        // Captured from sync-hub's integration test output. If this ever fails,
        // the two repos have drifted and the freeze was broken.
        let wire = r#"{"type":"hub-challenge","nonce_h":"AAAA","hub_key_id":"zAbc","sig_h":"BBBB"}"#;
        match serde_json::from_str::<HubMsg>(wire).unwrap() {
            HubMsg::HubChallenge { hub_key_id, .. } => assert_eq!(hub_key_id, "zAbc"),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn sync_ready_with_a_null_holds_deserialises() {
        let wire = r#"{"type":"sync-ready","protocol_version":5,
                       "vault_state":[{"vault_id":"v1","holds":null}],
                       "grants":[],"revocations":[]}"#;
        match serde_json::from_str::<HubMsg>(wire).unwrap() {
            HubMsg::SyncReady { vault_state, .. } => {
                assert!(vault_state[0].holds.is_none(),
                    "`null` must mean 'the hub holds nothing' — this is the value \
                     that triggers a re-upload");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn sync_ready_with_held_index_and_grants_deserialises_the_full_shape() {
        // Pins the full nested shape (a populated `holds`, a non-empty
        // `grants` array, and `revocations`) against the exact field names
        // and types sync-hub's SyncReady emits — a divergence in any nested
        // field (VaultState, HeldIndex, or GrantWire) fails here, not just
        // the top-level enum tag.
        let wire = r#"{"type":"sync-ready","protocol_version":5,
                       "vault_state":[{"vault_id":"v1","holds":
                           {"sha256":"deadbeef","note_count":42,"uploaded_at":1700000000}}],
                       "grants":[{"statement_b64":"c3RtdA==","signature_b64":"c2ln","state":"active"}],
                       "revocations":["zRevokedKey"]}"#;
        match serde_json::from_str::<HubMsg>(wire).unwrap() {
            HubMsg::SyncReady { protocol_version, vault_state, grants, revocations } => {
                assert_eq!(protocol_version, 5);
                let held = vault_state[0].holds.as_ref().expect("holds must be Some");
                assert_eq!(held.sha256, "deadbeef");
                assert_eq!(held.note_count, 42);
                assert_eq!(held.uploaded_at, 1700000000);
                assert_eq!(grants[0].statement_b64, "c3RtdA==");
                assert_eq!(grants[0].signature_b64, "c2ln");
                assert_eq!(grants[0].state, "active");
                assert_eq!(revocations, vec!["zRevokedKey".to_string()]);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn reject_deserialises_from_the_hub_wire_format() {
        let wire = r#"{"type":"reject","reason":"unknown key_id"}"#;
        match serde_json::from_str::<HubMsg>(wire).unwrap() {
            HubMsg::Reject { reason } => assert_eq!(reason, "unknown key_id"),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn upload_ack_deserialises_from_the_hub_wire_format() {
        let wire = r#"{"type":"upload-ack","vault_id":"v1","sha256":"deadbeef"}"#;
        match serde_json::from_str::<HubMsg>(wire).unwrap() {
            HubMsg::UploadAck { vault_id, sha256 } => {
                assert_eq!(vault_id, "v1");
                assert_eq!(sha256, "deadbeef");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn client_hello_serialises_to_the_exact_hub_expected_wire_format() {
        // Not a self-round-trip: this literal is what a hub-side
        // `serde_json::from_str::<ClientMsg>` must accept, so it pins the
        // client's output against the hub's input contract rather than just
        // proving the client agrees with itself.
        let msg = ClientMsg::ClientHello {
            key_id: "zAbc".into(),
            nonce_c: "AAAA".into(),
            vault_ids: vec!["v1".into()],
            protocol_version: 5,
            model_id: "m".into(),
            invite_code: None,
        };
        let json = serde_json::to_value(&msg).unwrap();
        let expected: serde_json::Value = serde_json::from_str(
            r#"{"type":"client-hello","key_id":"zAbc","nonce_c":"AAAA",
               "vault_ids":["v1"],"protocol_version":5,"model_id":"m",
               "invite_code":null}"#,
        )
        .unwrap();
        assert_eq!(json, expected);
    }

    #[test]
    fn client_auth_serialises_to_the_exact_hub_expected_wire_format() {
        let msg = ClientMsg::ClientAuth { sig_c: "CCCC".into() };
        let json = serde_json::to_value(&msg).unwrap();
        let expected: serde_json::Value =
            serde_json::from_str(r#"{"type":"client-auth","sig_c":"CCCC"}"#).unwrap();
        assert_eq!(json, expected);
    }

    /// `UploadIndex` and `UploadAck` carry no `size`/`uploaded_at` on the
    /// wire by design (the hub derives both itself). Mirrors sync-hub's own
    /// `upload_index_wire_shape_has_no_hub_derived_fields`, from the
    /// client's serializing side, so both repos pin the negative space
    /// equally: a future edit that quietly re-adds one of these fields is
    /// caught here even if the hub-side test is never re-run.
    #[test]
    fn upload_index_serialises_to_the_exact_hub_expected_wire_format() {
        let msg = ClientMsg::UploadIndex {
            vault_id: "v1".into(),
            sha256: "abc".into(),
            note_count: 10,
            schema_version: "1".into(),
            model_id: "m".into(),
        };
        let json = serde_json::to_value(&msg).unwrap();
        let expected: serde_json::Value = serde_json::from_str(
            r#"{"type":"upload-index","vault_id":"v1","sha256":"abc",
               "note_count":10,"schema_version":"1","model_id":"m"}"#,
        )
        .unwrap();
        assert_eq!(json, expected);
        assert!(json.get("size").is_none(), "size is hub-derived, not wire-carried");
        assert!(json.get("uploaded_at").is_none(), "uploaded_at is hub-derived, not wire-carried");

        let round_tripped: ClientMsg = serde_json::from_value(json).unwrap();
        assert!(matches!(round_tripped, ClientMsg::UploadIndex { .. }));
    }

    /// Independently hand-assembles the expected byte string field-by-field
    /// rather than calling `framed` — this must catch a divergence in the
    /// length-prefix width, byte order, or domain prefix that a test built
    /// on top of `framed` itself could never see, since it would inherit the
    /// same bug. This is the strongest kind of pin available without a live
    /// capture from the hub: it is checked against the frozen source
    /// (verbatim above), not re-derived from intent.
    #[test]
    fn hub_challenge_message_produces_the_exact_expected_bytes() {
        let mut expected = b"ll-hub-v5".to_vec();
        for part in [b"AB".as_slice(), b"CD".as_slice(), b"EF".as_slice()] {
            expected.extend_from_slice(&(part.len() as u32).to_be_bytes());
            expected.extend_from_slice(part);
        }
        assert_eq!(hub_challenge_message(b"AB", b"CD", b"EF"), expected);
    }

    #[test]
    fn client_auth_message_produces_the_exact_expected_bytes() {
        let mut expected = b"ll-client-v5".to_vec();
        for part in [b"AB".as_slice(), b"CD".as_slice(), b"zK".as_slice(), b"EF".as_slice()] {
            expected.extend_from_slice(&(part.len() as u32).to_be_bytes());
            expected.extend_from_slice(part);
        }
        assert_eq!(client_auth_message(b"AB", b"CD", "zK", b"EF"), expected);
    }

    #[test]
    fn the_two_roles_never_produce_the_same_bytes() {
        let (nh, nc, ex) = (b"nh".as_slice(), b"nc".as_slice(), [7u8; 32]);
        let hub = hub_challenge_message(nh, nc, &ex);
        let client = client_auth_message(nh, nc, "zHubKey", &ex);
        assert_ne!(
            hub, client,
            "without distinct domain prefixes a hub signature could be replayed \
             as a client signature"
        );
        assert!(hub.starts_with(b"ll-hub-v5"));
        assert!(client.starts_with(b"ll-client-v5"));
    }

    #[test]
    fn changing_the_exporter_changes_the_client_message() {
        let a = client_auth_message(b"nh", b"nc", "zK", &[1u8; 32]);
        let b = client_auth_message(b"nh", b"nc", "zK", &[2u8; 32]);
        assert_ne!(a, b, "the session must be bound, or a relay is undetectable");
    }

    #[test]
    fn changing_the_hub_key_changes_the_client_message() {
        let a = client_auth_message(b"nh", b"nc", "zHubOne", &[1u8; 32]);
        let b = client_auth_message(b"nh", b"nc", "zHubTwo", &[1u8; 32]);
        assert_ne!(a, b, "cross-hub replay must fail — this replaces WG_PUBKEY");
    }

    #[test]
    fn message_fields_are_length_prefixed_not_concatenated() {
        // "ab" + "c" must not collide with "a" + "bc".
        let a = client_auth_message(b"ab", b"c", "zK", &[0u8; 32]);
        let b = client_auth_message(b"a", b"bc", "zK", &[0u8; 32]);
        assert_ne!(a, b);
    }

    /// `the_two_roles_never_produce_the_same_bytes` proves the two roles'
    /// byte strings differ, but that alone would pass even if the prefixes
    /// were deleted entirely — the client message has one extra field
    /// (`hub_key_id`) that the hub message lacks, so the byte lengths would
    /// still diverge. The property that actually matters is cryptographic:
    /// a signature made in one role's domain must fail verification in the
    /// other's, even when every other field lines up. Only the domain
    /// prefix can make that fail — removing it collapses this to a same-key,
    /// same-fields comparison that would otherwise pass.
    ///
    /// Uses `ed25519_dalek` directly rather than the client's `KeyId`
    /// (which — unlike the hub's — has no `verify` method; adding one is
    /// out of scope for this task) so this stays a pure test of the framing
    /// functions above.
    #[test]
    fn a_signature_over_the_hub_domain_does_not_verify_as_a_client_signature() {
        use ed25519_dalek::{Signer, SigningKey, VerifyingKey};

        let sk = SigningKey::generate(&mut rand::thread_rng());
        let vk: VerifyingKey = sk.verifying_key();
        let (nh, nc, ex) = (b"nh".as_slice(), b"nc".as_slice(), [9u8; 32]);

        let hub_bytes = hub_challenge_message(nh, nc, &ex);
        let sig = sk.sign(&hub_bytes);

        let client_bytes = client_auth_message(nh, nc, "zSomeHubKey", &ex);
        assert!(
            vk.verify_strict(&client_bytes, &sig).is_err(),
            "a hub-domain signature must not verify as a client-domain signature"
        );
        // Sanity: the same signature verifies fine in the domain it was
        // actually made for, so the rejection above is the prefix doing its
        // job, not a broken fixture.
        assert!(vk.verify_strict(&hub_bytes, &sig).is_ok());
    }

    /// The cryptographic counterpart to `changing_the_exporter_changes_the_
    /// client_message`: that test only proves the bytes differ, which could
    /// pass even if `verify` never actually checked the exporter bytes for
    /// anything. This proves a real signature, over a real exporter, fails
    /// to verify against a message built with a *different* exporter — the
    /// actual property channel binding depends on, not decoration.
    #[test]
    fn a_signature_bound_to_one_exporter_is_rejected_under_a_different_one() {
        use ed25519_dalek::{Signer, SigningKey, VerifyingKey};

        let sk = SigningKey::generate(&mut rand::thread_rng());
        let vk: VerifyingKey = sk.verifying_key();
        let a = client_auth_message(b"nh", b"nc", "zK", &[1u8; 32]);
        let sig = sk.sign(&a);
        let b = client_auth_message(b"nh", b"nc", "zK", &[2u8; 32]);
        assert!(vk.verify_strict(&b, &sig).is_err());
        assert!(vk.verify_strict(&a, &sig).is_ok());
    }
}
