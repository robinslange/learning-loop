//! Control-plane JSON messages: `ClientMessage`, `HubMessage`, `PeerInfo`,
//! and the `EnvelopeMeta` projection of the JSON `PeerEnvelope` field.

use serde::{Deserialize, Serialize};

use crate::sync::error::SyncError;

/// Default for `SyncReady.protocol_version` when the hub omits the field
/// (legacy hub pre-2J).
pub(crate) fn default_protocol_v1() -> u32 {
    1
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClientMessage {
    SyncHello {
        peer_id: String,
        model_id: String,
        supported_models: Vec<String>,
        schema_version: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        protocol_version: Option<u32>,
    },
    AuthResponse {
        signature: String,
    },
    ListPeers,
    GetPeerIndex {
        peer_id: String,
    },
    GetPeerEnvelope {
        peer_id: String,
    },
    UploadEnvelope {
        envelope: serde_json::Value,
    },
    SyncSkipUpload,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum HubMessage {
    AuthChallenge {
        nonce: String,
        hub_pubkey: String,
    },
    SyncReady {
        peer_id: String,
        #[serde(default = "default_protocol_v1")]
        protocol_version: u32,
    },
    SyncReject {
        reason: String,
    },
    SyncAck {
        note_count: i64,
        /// Hex sha256 of the hub's stored index after this upload landed.
        /// Echoed by v3 hubs so the client can update its `base-export.sha256`
        /// to match what the hub has, even when SQLite session apply produced
        /// a row-equivalent-but-not-byte-equivalent DB on the hub side.
        #[serde(default)]
        stored_sha256: Option<String>,
    },
    PeerList {
        peers: Vec<PeerInfo>,
    },
    PeerEnvelope {
        envelope: Option<serde_json::Value>,
    },
    SyncSkipAck,
}

#[derive(Debug, Deserialize)]
pub struct PeerInfo {
    pub peer_id: String,
    pub updated_at: String,
    pub note_count: i64,
    pub pub_key: Option<String>,
    #[serde(default)]
    pub protocol_version: Option<u32>,
}

/// Decoded view of the JSON `PeerEnvelope` control-plane message.
///
/// The wire form is `serde_json::Value`; this struct provides a structured
/// projection so callers can compare in-frame `[u8; 32]` hash against the hex
/// string field without re-decoding ad-hoc.
#[derive(Debug)]
pub struct EnvelopeMeta {
    pub peer_id: String,
    pub sha256: String,
    pub signature: String,
    pub pub_key: String,
    pub signed_at: String,
    pub graph: bool,
    pub size: Option<u32>,
}

impl EnvelopeMeta {
    pub fn from_value(v: &serde_json::Value) -> std::result::Result<Self, SyncError> {
        let bad = |field: &str| SyncError::Json(serde::de::Error::custom(format!(
            "EnvelopeMeta missing or invalid {field}"
        )));
        Ok(EnvelopeMeta {
            peer_id: v.get("peer_id").and_then(|x| x.as_str()).ok_or_else(|| bad("peer_id"))?.to_string(),
            sha256: v.get("sha256").and_then(|x| x.as_str()).ok_or_else(|| bad("sha256"))?.to_string(),
            signature: v.get("signature").and_then(|x| x.as_str()).ok_or_else(|| bad("signature"))?.to_string(),
            pub_key: v.get("pub_key").and_then(|x| x.as_str()).ok_or_else(|| bad("pub_key"))?.to_string(),
            signed_at: v.get("signed_at").and_then(|x| x.as_str()).ok_or_else(|| bad("signed_at"))?.to_string(),
            graph: v.get("graph").and_then(|x| x.as_bool()).unwrap_or(false),
            size: v.get("size").and_then(|x| x.as_u64()).and_then(|n| u32::try_from(n).ok()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::PROTOCOL_VERSION_FRAMED;

    fn round_trip_client(msg: &ClientMessage) -> serde_json::Value {
        let json = serde_json::to_string(msg).expect("serialize");
        serde_json::from_str(&json).expect("parse back")
    }

    #[test]
    fn sync_hello_serializes_type_tag() {
        let msg = ClientMessage::SyncHello {
            peer_id: "p1".into(),
            model_id: "bge-small".into(),
            supported_models: vec!["bge-small".into()],
            schema_version: 1,
            protocol_version: None,
        };
        let v = round_trip_client(&msg);
        assert_eq!(v["type"].as_str(), Some("sync-hello"));
        assert_eq!(v["peer_id"].as_str(), Some("p1"));
        assert_eq!(v["schema_version"].as_u64(), Some(1));
        assert!(
            v.get("protocol_version").is_none(),
            "protocol_version: None should be skipped on the wire so legacy hubs do not see an unknown field",
        );
    }

    #[test]
    fn sync_hello_includes_protocol_version_when_set() {
        let msg = ClientMessage::SyncHello {
            peer_id: "p1".into(),
            model_id: "bge-small".into(),
            supported_models: vec!["bge-small".into()],
            schema_version: 1,
            protocol_version: Some(PROTOCOL_VERSION_FRAMED),
        };
        let v = round_trip_client(&msg);
        assert_eq!(v["protocol_version"].as_u64(), Some(2));
    }

    #[test]
    fn sync_ready_defaults_protocol_v1_when_absent() {
        let json = r#"{"type":"sync-ready","peer_id":"hub"}"#;
        let msg: HubMessage = serde_json::from_str(json).expect("deserialize");
        match msg {
            HubMessage::SyncReady { peer_id, protocol_version } => {
                assert_eq!(peer_id, "hub");
                assert_eq!(protocol_version, 1, "missing field on wire must serde-default to 1 for legacy hubs");
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn sync_ready_parses_protocol_v2() {
        let json = r#"{"type":"sync-ready","peer_id":"hub","protocol_version":2}"#;
        let msg: HubMessage = serde_json::from_str(json).expect("deserialize");
        match msg {
            HubMessage::SyncReady { protocol_version, .. } => {
                assert_eq!(protocol_version, 2);
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn auth_response_serializes_type_tag() {
        let msg = ClientMessage::AuthResponse { signature: "sig123".into() };
        let v = round_trip_client(&msg);
        assert_eq!(v["type"].as_str(), Some("auth-response"));
        assert_eq!(v["signature"].as_str(), Some("sig123"));
    }

    #[test]
    fn unit_variants_serialize_without_extra_fields() {
        let list_peers = round_trip_client(&ClientMessage::ListPeers);
        assert_eq!(list_peers["type"].as_str(), Some("list-peers"));
        assert!(list_peers.as_object().is_some_and(|o| o.len() == 1));

        let skip = round_trip_client(&ClientMessage::SyncSkipUpload);
        assert_eq!(skip["type"].as_str(), Some("sync-skip-upload"));
    }

    #[test]
    fn get_peer_index_includes_peer_id() {
        let msg = ClientMessage::GetPeerIndex { peer_id: "peer-x".into() };
        let v = round_trip_client(&msg);
        assert_eq!(v["type"].as_str(), Some("get-peer-index"));
        assert_eq!(v["peer_id"].as_str(), Some("peer-x"));
    }

    #[test]
    fn hub_auth_challenge_deserializes() {
        let json = r#"{"type":"auth-challenge","nonce":"abc123","hub_pubkey":"pubkey"}"#;
        let msg: HubMessage = serde_json::from_str(json).expect("deserialize");
        match msg {
            HubMessage::AuthChallenge { nonce, hub_pubkey } => {
                assert_eq!(nonce, "abc123");
                assert_eq!(hub_pubkey, "pubkey");
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn hub_sync_ack_deserializes_note_count() {
        let json = r#"{"type":"sync-ack","note_count":42}"#;
        let msg: HubMessage = serde_json::from_str(json).expect("deserialize");
        match msg {
            HubMessage::SyncAck { note_count, .. } => assert_eq!(note_count, 42),
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn hub_peer_list_deserializes_peers() {
        let json = r#"{"type":"peer-list","peers":[{"peer_id":"p1","updated_at":"2024-01-01","note_count":10,"pub_key":null}]}"#;
        let msg: HubMessage = serde_json::from_str(json).expect("deserialize");
        match msg {
            HubMessage::PeerList { peers } => {
                assert_eq!(peers.len(), 1);
                assert_eq!(peers[0].peer_id, "p1");
                assert_eq!(peers[0].note_count, 10);
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn hub_sync_reject_deserializes_reason() {
        let json = r#"{"type":"sync-reject","reason":"not authorized"}"#;
        let msg: HubMessage = serde_json::from_str(json).expect("deserialize");
        match msg {
            HubMessage::SyncReject { reason } => assert_eq!(reason, "not authorized"),
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn hub_sync_skip_ack_deserializes() {
        let json = r#"{"type":"sync-skip-ack"}"#;
        let msg: HubMessage = serde_json::from_str(json).expect("deserialize");
        assert!(matches!(msg, HubMessage::SyncSkipAck));
    }

    #[test]
    fn envelope_meta_from_value_happy_path_all_fields() {
        let v = serde_json::json!({
            "peer_id": "p1",
            "sha256": "deadbeef",
            "signature": "sig",
            "pub_key": "pk",
            "signed_at": "2026-05-14T12:00:00Z",
            "graph": true,
            "size": 4096,
            "extra_field_for_forward_compat": "ignored",
        });
        let meta = EnvelopeMeta::from_value(&v).expect("happy path must parse");
        assert_eq!(meta.peer_id, "p1");
        assert_eq!(meta.sha256, "deadbeef");
        assert_eq!(meta.signature, "sig");
        assert_eq!(meta.pub_key, "pk");
        assert_eq!(meta.signed_at, "2026-05-14T12:00:00Z");
        assert!(meta.graph);
        assert_eq!(meta.size, Some(4096));
    }

    #[test]
    fn envelope_meta_graph_defaults_to_false_when_absent() {
        let v = serde_json::json!({
            "peer_id": "p1",
            "sha256": "x",
            "signature": "s",
            "pub_key": "k",
            "signed_at": "t",
        });
        let meta = EnvelopeMeta::from_value(&v).expect("missing graph must default, not error");
        assert!(!meta.graph);
        assert!(meta.size.is_none(), "missing size must yield None");
    }

    #[test]
    fn envelope_meta_size_oversized_for_u32_becomes_none() {
        // u64::MAX > u32::MAX → u32::try_from fails → size = None.
        // Behaviour-preserving guard against silent truncation.
        let v = serde_json::json!({
            "peer_id": "p", "sha256": "x", "signature": "s", "pub_key": "k", "signed_at": "t",
            "size": u64::MAX,
        });
        let meta = EnvelopeMeta::from_value(&v).expect("oversized size must not error");
        assert!(meta.size.is_none(), "value beyond u32::MAX must become None, not truncate");
    }

    #[test]
    fn envelope_meta_missing_peer_id_errors() {
        let v = serde_json::json!({
            "sha256": "x", "signature": "s", "pub_key": "k", "signed_at": "t",
        });
        let err = EnvelopeMeta::from_value(&v).expect_err("missing peer_id must error");
        assert!(matches!(err, SyncError::Json(_)));
        assert!(format!("{err}").contains("peer_id"), "error must name the missing field");
    }

    #[test]
    fn envelope_meta_missing_sha256_errors() {
        let v = serde_json::json!({
            "peer_id": "p", "signature": "s", "pub_key": "k", "signed_at": "t",
        });
        let err = EnvelopeMeta::from_value(&v).expect_err("missing sha256 must error");
        assert!(format!("{err}").contains("sha256"));
    }

    #[test]
    fn envelope_meta_wrong_type_for_required_field_errors() {
        // peer_id present but as a number — as_str() returns None, same path as missing.
        let v = serde_json::json!({
            "peer_id": 42,
            "sha256": "x", "signature": "s", "pub_key": "k", "signed_at": "t",
        });
        let err = EnvelopeMeta::from_value(&v).expect_err("non-string peer_id must error");
        assert!(format!("{err}").contains("peer_id"));
    }

    #[test]
    fn envelope_meta_graph_wrong_type_falls_back_to_false() {
        // graph: "yes" — as_bool() returns None → unwrap_or(false). Best-effort,
        // documented behaviour: only `true`/`false` count, anything else = false.
        let v = serde_json::json!({
            "peer_id": "p", "sha256": "x", "signature": "s", "pub_key": "k", "signed_at": "t",
            "graph": "yes",
        });
        let meta = EnvelopeMeta::from_value(&v).expect("non-bool graph must not error");
        assert!(!meta.graph);
    }
}
