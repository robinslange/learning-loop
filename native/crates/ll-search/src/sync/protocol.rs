use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClientMessage {
    SyncHello {
        peer_id: String,
        model_id: String,
        supported_models: Vec<String>,
        schema_version: u32,
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
    },
    SyncReject {
        reason: String,
    },
    SyncAck {
        note_count: i64,
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
        };
        let v = round_trip_client(&msg);
        assert_eq!(v["type"].as_str(), Some("sync-hello"));
        assert_eq!(v["peer_id"].as_str(), Some("p1"));
        assert_eq!(v["schema_version"].as_u64(), Some(1));
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
            HubMessage::SyncAck { note_count } => assert_eq!(note_count, 42),
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
}
