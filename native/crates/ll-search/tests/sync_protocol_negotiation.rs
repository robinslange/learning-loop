//! End-to-end protocol_version negotiation tests.
//!
//! The bilateral wire contract is co-authored with the sync-hub side at
//! `/Users/robin/dev/sync-hub/docs/plans/2026-05-11-envelope-framing.md`.
//! Field name is `protocol_version` (not `schema_version`, which is already
//! taken by the index-DB row version on `SyncHello`).

#[test]
fn protocol_version_field_name_pin() {
    // This test exists to surface accidental renames of the `protocol_version` wire field.
    // It does not exercise the runtime; it asserts on the literal JSON key seen by the
    // sync-hub plan at
    //   /Users/robin/dev/sync-hub/docs/plans/2026-05-11-envelope-framing.md
    // and the 2J plan at
    //   /Users/robin/brain/learning-loop/.planning/refactors/phase2/2J.md
    use ll_search::sync::protocol::{ClientMessage, HubMessage};

    let hello = ClientMessage::SyncHello {
        peer_id: "alice".into(),
        model_id: "model".into(),
        supported_models: vec!["model".into()],
        schema_version: 1,
        protocol_version: Some(2),
    };
    let json = serde_json::to_string(&hello).unwrap();
    assert!(
        json.contains(r#""protocol_version":2"#),
        "SyncHello serialization must include `\"protocol_version\":2` literally; got: {json}",
    );
    assert!(
        json.contains(r#""schema_version":1"#),
        "SyncHello must still include `\"schema_version\":1` (index-DB row version); got: {json}",
    );

    let ready_json = r#"{"type":"sync-ready","peer_id":"hub","protocol_version":2}"#;
    let msg: HubMessage = serde_json::from_str(ready_json).unwrap();
    match msg {
        HubMessage::SyncReady { protocol_version, .. } => {
            assert_eq!(protocol_version, 2, "SyncReady must deserialise from the wire field `protocol_version`");
        }
        _ => panic!("wrong variant"),
    }
}

