use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClientMessage {
    SyncHello {
        peer_id: String,
        model_id: String,
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
}

#[derive(Debug, Deserialize)]
pub struct PeerInfo {
    pub peer_id: String,
    pub updated_at: String,
    pub note_count: i64,
    pub pub_key: Option<String>,
}
