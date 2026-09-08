//! Client half of the v5 handshake: pin the hub's `key_id`, prove possession
//! of the local signing key, and refuse anything that isn't a
//! `HubChallenge`.
//!
//! No downgrade path: v4 accepted a `SyncReady` sent straight after
//! `SyncHello` (an "unauthenticated hub" branch, logged and continued). v5
//! has exactly one acceptable message after `ClientHello`, and every other
//! message — including that one — is a protocol violation, not a warning.

use crate::b64;
use ed25519_dalek::{Signer, SigningKey};

use super::client::{recv_json, send_json, WsStream};
use super::config::FederationConfig;
use super::key_id::KeyId;
use super::protocol_v5::{
    client_auth_message, hub_challenge_message, ClientMsg, GrantWire, HubMsg, RevocationWire,
    VaultState, PROTOCOL_VERSION,
};

/// TLS exporter label per RFC 9266-style channel binding.
///
/// Three things must match the hub's `tls::exporter` byte-for-byte, and only
/// the first of them is a named constant: this label, the 32-byte output
/// length, and the `None` context passed to `export_keying_material`. Get any
/// of the three wrong and every signature verification fails with nothing to
/// diagnose but "invalid signature" — the two sides derive different bytes
/// and neither can tell you why.
///
/// `exporter_label_is_stable` below pins the label here; the hub pins the
/// same literal in its own test. Neither test can see the other repo, so the
/// literal IS the contract: changing the constant fails the local test, which
/// is what puts the person who changed it in front of this comment.
pub const EXPORTER_LABEL: &[u8] = b"EXPORTER-ll-federation-v5";

/// What a successful handshake hands back to the sync pipeline.
#[derive(Debug, Clone)]
pub struct SyncReadyPayload {
    pub protocol_version: u32,
    pub vault_state: Vec<VaultState>,
    pub grants: Vec<GrantWire>,
    pub revocations: Vec<RevocationWire>,
}

pub(super) fn random_nonce() -> [u8; 32] {
    rand::random()
}

/// Authenticate to the hub named in `config.hub`, over a connection whose
/// TLS channel-binding value is `exporter`. Returns the hub's post-auth
/// state on success. Any other message shape, or a failed pin/signature
/// check, is an error — there is no partial-trust fallback.
/// `model_id` is the embedding model this vault's vectors were produced by,
/// and it is the caller's to supply: on sync it comes from the index the
/// export was built from, and nothing else is authoritative about vectors
/// already on disk. It used to be read from the process-global embedding
/// provider, which meant any path that had not loaded a model announced
/// "unknown" -- and "unknown" is the value that makes every peer's
/// `discover_peer_dbs` drop to BM25 for this vault.
pub async fn authenticate(
    ws: &mut WsStream,
    seed: &SigningKey,
    config: &FederationConfig,
    vault_ids: &[String],
    exporter: &[u8; 32],
    model_id: &str,
    invite: Option<&str>,
) -> anyhow::Result<SyncReadyPayload> {
    let key_id = KeyId::from_pubkey(&seed.verifying_key());
    let nonce_c = random_nonce();

    send_json(ws, &ClientMsg::ClientHello {
        key_id: key_id.as_str().to_string(),
        nonce_c: b64::encode(&nonce_c),
        vault_ids: vault_ids.to_vec(),
        protocol_version: PROTOCOL_VERSION,
        model_id: model_id.to_string(),
        invite_code: invite.map(str::to_string),
    }).await?;

    // Exactly one acceptable message here. There is no branch that treats a
    // SyncReady as success — v4 had one, and it let a hostile endpoint skip
    // authentication entirely.
    let (nonce_h, hub_key_id, sig_h) = match recv_json::<HubMsg>(ws).await? {
        HubMsg::HubChallenge { nonce_h, hub_key_id, sig_h } => (nonce_h, hub_key_id, sig_h),
        HubMsg::Reject { reason } => anyhow::bail!("hub rejected: {reason}"),
        other => anyhow::bail!("expected hub-challenge, got {other:?}"),
    };

    // Pin check first, verification second. The hub's identity is decided by
    // this comparison, not by whether some signature happens to check out —
    // a hostile hub can sign genuinely with a key of its own choosing, so
    // "the signature verifies" only means "this key produced this
    // signature", never "this is the key we pinned".
    let pinned = config.hub.key_id.as_deref()
        .ok_or_else(|| anyhow::anyhow!("no hub key pinned; re-run `ll join`"))?;
    if pinned != hub_key_id {
        anyhow::bail!(
            "hub key mismatch: pinned {pinned}, presented {hub_key_id}. \
             Refusing to continue."
        );
    }

    let nonce_h_raw = b64::decode(&nonce_h)?;
    let hub_key = KeyId::parse(&hub_key_id)?;
    hub_key
        .verify(&hub_challenge_message(&nonce_h_raw, &nonce_c, exporter), &b64::decode(&sig_h)?)
        .map_err(|e| anyhow::anyhow!("hub signature did not verify: {e}"))?;

    let sig_c = seed.sign(&client_auth_message(&nonce_h_raw, &nonce_c, &hub_key_id, exporter));
    send_json(ws, &ClientMsg::ClientAuth { sig_c: b64::encode(&sig_c.to_bytes()) }).await?;

    match recv_json::<HubMsg>(ws).await? {
        HubMsg::SyncReady { protocol_version, vault_state, grants, revocations } =>
            Ok(SyncReadyPayload { protocol_version, vault_state, grants, revocations }),
        HubMsg::Reject { reason } => anyhow::bail!("auth failed: {reason}"),
        other => anyhow::bail!("expected sync-ready, got {other:?}"),
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::test_hub::{
        fake_hub_happy_path, hub_key_id_str, hub_signing_key, recv_client_msg, HubVaults,
        send_hub_msg, send_signed_challenge, spawn_mock_hub, MockHub,
    };

    /// Config with the hub key pinned to `hub_signing_key()`'s identity —
    /// what a real client would have after `ll join` against this mock hub.
    fn pinned_config() -> FederationConfig {
        let mut c = FederationConfig::test_fixture("private", vec![]);
        c.hub.key_id = Some(hub_key_id_str());
        c
    }

    /// Config with no hub key pinned at all (the `test_fixture` default).
    fn test_config() -> FederationConfig {
        FederationConfig::test_fixture("private", vec![])
    }

    /// The twin of the hub's `exporter_label_is_stable`. Neither repo can see
    /// the other, so the literal is the contract — changing the constant on
    /// one side fails that side's test rather than silently breaking every
    /// channel binding while both halves still compile and still "work".
    #[test]
    fn exporter_label_is_stable() {
        assert_eq!(EXPORTER_LABEL, b"EXPORTER-ll-federation-v5");
    }

    async fn run_handshake(hub: &MockHub, config: &FederationConfig) -> anyhow::Result<SyncReadyPayload> {
        run_handshake_with_exporter(hub, config, &[0u8; 32]).await
    }

    async fn run_handshake_with_exporter(
        hub: &MockHub,
        config: &FederationConfig,
        exporter: &[u8; 32],
    ) -> anyhow::Result<SyncReadyPayload> {
        let (mut ws, _) = tokio_tungstenite::connect_async(hub.ws_url())
            .await
            .expect("mock hub connection failed");
        let seed = SigningKey::generate(&mut rand::thread_rng());
        authenticate(&mut ws, &seed, config, &[String::from("v1")], exporter, "test-model", None).await
    }

    /// The hub records the embedding model from `ClientHello`, and a peer whose
    /// recorded model does not match the searcher's drops to BM25. The value
    /// used to come from the process-global provider, so `join` -- which never
    /// loads a model -- announced "unknown" and nothing noticed, because no
    /// test had ever read this field off the wire.
    #[tokio::test]
    async fn client_hello_carries_the_model_id_it_was_given() {
        let (tx, rx) = std::sync::mpsc::channel();
        let hub = spawn_mock_hub(move |mut ws| {
            let tx = tx.clone();
            async move {
                let hello = recv_client_msg(&mut ws).await;
                if let Some(ClientMsg::ClientHello { model_id, .. }) = hello {
                    let _ = tx.send(model_id);
                }
                send_hub_msg(&mut ws, &HubMsg::Reject { reason: "done".into() }).await;
            }
        })
        .await;

        let config = test_config();
        let _ = run_handshake(&hub, &config).await;

        let seen = rx.recv().expect("hub never received a ClientHello");
        assert_eq!(seen, "test-model", "the model the caller supplied must reach the wire");
        assert_ne!(seen, "unknown", "an uninitialised provider must not decide this");
    }

    /// `join` runs before the vault has an index, so it cannot read a model id
    /// out of one -- but the model this client embeds with is known statically
    /// and must be what it announces.
    #[test]
    fn the_join_model_id_is_the_model_this_client_embeds_with() {
        let declared = &crate::model::KnownModel::BgeSmallEnV15.config().model_id;
        assert_eq!(declared, "Xenova/bge-small-en-v1.5");
        assert_ne!(declared, "unknown");
    }

    async fn fake_hub_presenting_key(key_id: &str) -> MockHub {
        let key_id = key_id.to_string();
        spawn_mock_hub(move |mut ws| async move {
            let _hello = recv_client_msg(&mut ws).await;
            send_hub_msg(&mut ws, &HubMsg::HubChallenge {
                nonce_h: b64::encode(&[1u8; 32]),
                hub_key_id: key_id,
                sig_h: b64::encode(&[0u8; 64]),
            }).await;
        }).await
    }

    async fn fake_hub_that_skips_the_challenge() -> MockHub {
        spawn_mock_hub(|mut ws| async move {
            let _hello = recv_client_msg(&mut ws).await;
            send_hub_msg(&mut ws, &HubMsg::SyncReady {
                protocol_version: PROTOCOL_VERSION,
                vault_state: vec![],
                grants: vec![],
                revocations: vec![],
            }).await;
        }).await
    }

    async fn fake_hub_with_bad_signature() -> MockHub {
        spawn_mock_hub(|mut ws| async move {
            let _hello = recv_client_msg(&mut ws).await;
            send_hub_msg(&mut ws, &HubMsg::HubChallenge {
                nonce_h: b64::encode(&[1u8; 32]),
                hub_key_id: hub_key_id_str(),
                sig_h: b64::encode(&[0xffu8; 64]),
            }).await;
        }).await
    }

    #[tokio::test]
    async fn aborts_when_the_hub_key_does_not_match_the_pin() {
        let hub = fake_hub_presenting_key("zImpostor").await;
        let mut cfg = test_config();
        cfg.hub.key_id = Some("zGenuine".into());
        let err = run_handshake(&hub, &cfg).await.unwrap_err();
        assert!(err.to_string().contains("hub key mismatch"));
    }

    #[tokio::test]
    async fn aborts_when_the_hub_sends_sync_ready_instead_of_a_challenge() {
        // v4's client accepted this and logged "Hub ready (no auth)".
        let hub = fake_hub_that_skips_the_challenge().await;
        let err = run_handshake(&hub, &pinned_config()).await.unwrap_err();
        assert!(err.to_string().contains("expected hub-challenge"));
    }

    #[tokio::test]
    async fn aborts_when_the_hub_signature_does_not_verify() {
        let hub = fake_hub_with_bad_signature().await;
        let err = run_handshake(&hub, &pinned_config()).await.unwrap_err();
        assert!(err.to_string().contains("hub signature"));
    }

    #[test]
    fn the_client_signs_with_its_own_domain_prefix_only() {
        let msg = client_auth_message(b"nh", b"nc", "zK", &[0u8; 32]);
        assert!(msg.starts_with(b"ll-client-v5"));
        assert!(!msg.starts_with(b"ll-hub-v5"),
            "signing with the hub's prefix would let a client signature be replayed \
             as a hub signature");
    }

    #[tokio::test]
    async fn a_successful_handshake_returns_the_vault_state() {
        let hub = fake_hub_happy_path(HubVaults::new()).await;
        let ready = run_handshake(&hub, &pinned_config()).await.unwrap();
        assert_eq!(ready.vault_state.len(), 1);
        assert!(ready.vault_state[0].holds.is_none());
    }

    /// THE critical pinning test. A garbled `sig_h` (see
    /// `aborts_when_the_hub_signature_does_not_verify`) would also pass under
    /// a broken implementation that trusts whatever key the message names —
    /// garbage bytes fail verification either way. This one can't pass under
    /// that bug: the signature is perfectly valid, just for a key that isn't
    /// the one pinned, so only a real pin comparison catches it.
    #[tokio::test]
    async fn aborts_on_a_hub_challenge_whose_key_is_genuinely_signed_but_not_the_pinned_one() {
        let attacker_sk = SigningKey::from_bytes(&[9u8; 32]);

        let hub = spawn_mock_hub(move |mut ws| async move {
            let Some(ClientMsg::ClientHello { nonce_c, .. }) = recv_client_msg(&mut ws).await else {
                // Stop rather than panic: this runs in a spawned task, where a
                // panic never fails the test that spawned it.
                return;
            };
            send_signed_challenge(&mut ws, &attacker_sk, &nonce_c).await;
        }).await;

        let err = run_handshake(&hub, &pinned_config()).await.unwrap_err();
        assert!(err.to_string().contains("hub key mismatch"),
            "a genuinely valid signature for an unpinned key must still be rejected on the \
             pin check, not accepted because the crypto happens to check out: {err}");
    }

    /// Channel binding with two well-formed, distinct exporter values — not a
    /// corrupted one. Simulates a relay that terminates TLS on both legs: each
    /// leg's exporter is a legitimate value, they just don't match because
    /// they came from two different TLS sessions.
    #[tokio::test]
    async fn aborts_when_the_exporter_does_not_match_the_hubs_view_of_the_channel() {
        let hub_exporter = [7u8; 32];
        let client_exporter = [8u8; 32];

        let hub = spawn_mock_hub(move |mut ws| async move {
            let Some(ClientMsg::ClientHello { nonce_c, .. }) = recv_client_msg(&mut ws).await else {
                // Stop rather than panic: this runs in a spawned task, where a
                // panic never fails the test that spawned it.
                return;
            };
            let nonce_c_raw = b64::decode(&nonce_c).unwrap();
            let nonce_h = random_nonce();
            let sig_h = hub_signing_key().sign(&hub_challenge_message(&nonce_h, &nonce_c_raw, &hub_exporter));
            send_hub_msg(&mut ws, &HubMsg::HubChallenge {
                nonce_h: b64::encode(&nonce_h),
                hub_key_id: hub_key_id_str(),
                sig_h: b64::encode(&sig_h.to_bytes()),
            }).await;
        }).await;

        let err = run_handshake_with_exporter(&hub, &pinned_config(), &client_exporter).await.unwrap_err();
        assert!(err.to_string().contains("hub signature"),
            "a relay presenting a different (but legitimate) connection's exporter must fail \
             signature verification: {err}");
    }

    #[tokio::test]
    async fn aborts_when_the_hub_rejects_the_hello() {
        let hub = spawn_mock_hub(|mut ws| async move {
            let _hello = recv_client_msg(&mut ws).await;
            send_hub_msg(&mut ws, &HubMsg::Reject { reason: "unknown key_id".into() }).await;
        }).await;
        let err = run_handshake(&hub, &pinned_config()).await.unwrap_err();
        assert!(err.to_string().contains("hub rejected: unknown key_id"));
    }

    #[tokio::test]
    async fn aborts_when_the_hub_rejects_after_client_auth() {
        let hub = spawn_mock_hub(|mut ws| async move {
            let Some(ClientMsg::ClientHello { nonce_c, .. }) = recv_client_msg(&mut ws).await else {
                // Stop rather than panic: this runs in a spawned task, where a
                // panic never fails the test that spawned it.
                return;
            };
            send_signed_challenge(&mut ws, &hub_signing_key(), &nonce_c).await;
            let _auth = recv_client_msg(&mut ws).await;
            send_hub_msg(&mut ws, &HubMsg::Reject { reason: "vault not permitted".into() }).await;
        }).await;
        let err = run_handshake(&hub, &pinned_config()).await.unwrap_err();
        assert!(err.to_string().contains("auth failed: vault not permitted"));
    }

    #[tokio::test]
    async fn aborts_when_no_hub_key_is_pinned_locally() {
        let hub = spawn_mock_hub(|mut ws| async move {
            let Some(ClientMsg::ClientHello { nonce_c, .. }) = recv_client_msg(&mut ws).await else {
                // Stop rather than panic: this runs in a spawned task, where a
                // panic never fails the test that spawned it.
                return;
            };
            send_signed_challenge(&mut ws, &hub_signing_key(), &nonce_c).await;
        }).await;

        let err = run_handshake(&hub, &test_config()).await.unwrap_err();
        assert!(err.to_string().contains("no hub key pinned"));
    }
}
