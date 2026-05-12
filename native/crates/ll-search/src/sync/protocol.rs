use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::error::SyncError;

/// Maximum envelope size accepted on either send or receive.
///
/// This is the **client-side policy ceiling**; the hub's axum
/// `WebSocketUpgrade::max_message_size` is the lower effective ceiling
/// for outbound uploads (see [`HUB_INBOUND_CAP`]).
pub const MAX_ENVELOPE_SIZE: usize = 200 * 1024 * 1024;

/// Bytes preceding the body in a framed binary message: 4 (size BE u32) + 32 (sha256).
pub const ENVELOPE_HEADER_LEN: usize = 4 + 32;

/// Hub's axum `WebSocketUpgrade::max_message_size`. Uploads above this are dropped
/// at the transport layer; pre-flight returns [`SyncError::EnvelopeOversize`].
pub const HUB_INBOUND_CAP: usize = 50 * 1024 * 1024;

/// Protocol version this client advertises in `SyncHello`.
pub const PROTOCOL_VERSION_FRAMED: u32 = 2;

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

/// Parsed peer-list `updated_at` reduced to unix-seconds for ordered comparison.
///
/// Tolerates trailing `Z`, fractional seconds, and `+00:00`/`-00:00` offsets. The
/// minimum parseable form is `YYYY-MM-DDTHH:MM:SS`. Anything else returns
/// `SyncError::BadTimestamp`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct PeerTimestamp(pub u64);

impl PeerTimestamp {
    pub fn parse(s: &str) -> std::result::Result<Self, SyncError> {
        let bad = || SyncError::BadTimestamp { raw: s.to_string() };

        // Strip leading whitespace; reject empty.
        let s = s.trim();
        if s.is_empty() {
            return Err(bad());
        }

        // Minimum: YYYY-MM-DDTHH:MM:SS (19 chars).
        if s.len() < 19 {
            return Err(bad());
        }

        let head = &s[..19];
        let tail = &s[19..];

        let bytes = head.as_bytes();
        if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' || bytes[13] != b':' || bytes[16] != b':' {
            return Err(bad());
        }
        let year: i64 = head[0..4].parse().map_err(|_| bad())?;
        let month: u32 = head[5..7].parse().map_err(|_| bad())?;
        let day: u32 = head[8..10].parse().map_err(|_| bad())?;
        let hour: u32 = head[11..13].parse().map_err(|_| bad())?;
        let minute: u32 = head[14..16].parse().map_err(|_| bad())?;
        let second: u32 = head[17..19].parse().map_err(|_| bad())?;

        // Parse the tail: optional fractional, then optional zone (Z or ±HH:MM).
        let mut rest = tail;
        if let Some(stripped) = rest.strip_prefix('.') {
            // Skip fractional digits.
            let frac_end = stripped
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(stripped.len());
            if frac_end == 0 {
                return Err(bad());
            }
            rest = &stripped[frac_end..];
        }

        // Time zone offset in seconds (positive east of UTC).
        let zone_offset_secs: i64 = if rest.is_empty() {
            // No zone -> assume UTC. Plenty of producers omit Z; match `chrono::DateTime::parse_from_rfc3339`
            // behaviour of *requiring* one, but we treat the lack as UTC for forward compat. This is
            // a known relaxation; see PeerTimestamp tests.
            0
        } else if rest == "Z" || rest == "z" {
            0
        } else if rest.len() == 6 && (rest.starts_with('+') || rest.starts_with('-')) && rest.as_bytes()[3] == b':' {
            let sign: i64 = if rest.starts_with('-') { -1 } else { 1 };
            let oh: i64 = rest[1..3].parse().map_err(|_| bad())?;
            let om: i64 = rest[4..6].parse().map_err(|_| bad())?;
            sign * (oh * 3600 + om * 60)
        } else {
            return Err(bad());
        };

        if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
            return Err(bad());
        }

        // Days from civil (Howard Hinnant's algorithm).
        // Returns days since 1970-01-01 for a given year/month/day.
        let y = if month <= 2 { year - 1 } else { year };
        let era = (if y >= 0 { y } else { y - 399 }) / 400;
        let yoe = (y - era * 400) as u64;
        let doy: u64 = (153 * (if month > 2 { month - 3 } else { month + 9 }) as u64 + 2) / 5
            + day as u64
            - 1;
        let doe: u64 = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days_since_epoch: i64 = era * 146_097 + doe as i64 - 719_468;

        let total_secs: i64 = days_since_epoch * 86_400
            + hour as i64 * 3600
            + minute as i64 * 60
            + second as i64
            - zone_offset_secs;
        if total_secs < 0 {
            return Err(bad());
        }
        Ok(PeerTimestamp(total_secs as u64))
    }
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
