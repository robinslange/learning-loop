//! FROZEN at sync-hub commit 5c36b487d4ba5d7045bb8f7227123cd6c85ec132 (Plan 3
//! Task 3). Copied verbatim from `sync-hub/src/v5/handshake.rs`.
//!
//! Deliberately duplicated rather than shared across a workspace dependency —
//! the two repos have independent release cycles. Any change to a struct
//! below requires the same change in sync-hub and a `PROTOCOL_VERSION` bump
//! in both repos, in one change. The pinned wire-format tests below guard
//! against silent divergence.

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
}
