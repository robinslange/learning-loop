//! Grant statements: what one key says about another.
//!
//! Deliberately duplicated from `sync-hub/src/v5/grant.rs` rather than shared
//! across a workspace dependency — the two repos have independent release
//! cycles, same as `key_id.rs` and `protocol_v5.rs`. `canonical_bytes` exists
//! for the SIGNING side only; `verify` checks against the exact bytes it is
//! handed, with no re-canonicalisation, because a signer signs whatever it
//! put on the wire.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::key_id::KeyId;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GrantKind { Follow, Link, Assoc, Peer }

impl GrantKind {
    pub fn default_ttl_secs(&self) -> i64 {
        match self {
            GrantKind::Link | GrantKind::Assoc => 365 * 86_400,
            GrantKind::Follow | GrantKind::Peer => 90 * 86_400,
        }
    }

    /// Whether this edge lets `to` act for `from`'s vaults.
    ///
    /// `Link` joins a person's own machines and grants full authority.
    /// `Assoc` joins a person's work and personal identities and grants NONE —
    /// merging the two would hand an employer-governed key the ability to act
    /// as a personal one, which is the entire reason for two keys.
    pub fn transfers_authority(&self) -> bool {
        matches!(self, GrantKind::Link)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GrantStatement {
    pub v: u8,
    pub kind: GrantKind,
    pub from: KeyId,
    pub to: KeyId,
    pub scope: Option<String>,
    pub issued_at: i64,
    pub expires_at: i64,
    pub nonce: String,
}

pub fn canonical_bytes<T: Serialize>(st: &T) -> Vec<u8> {
    serde_json::to_vec(st).expect("statement is always serialisable")
}

pub fn grant_id(statement_bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(statement_bytes))
}

/// `from` is attacker-controlled content inside `statement_bytes`, and it is
/// checked against `expected_from` before the cryptographic check.
///
/// **This is not the same property as `handshake.rs`'s pin-then-verify, and
/// the difference is worth knowing.** There, the comparison decides *which
/// key to trust*, so doing it second would mean trusting a key because it
/// signed something — a hostile hub can always do that. Here the signature is
/// verified against `expected_from`, the caller's parameter, never against
/// `st.from`, so no ordering of these two checks can admit a wrong key. The
/// caller already decided whose signature this must be.
///
/// What the ordering buys is smaller and real: a string comparison rejects
/// before Ed25519 verification runs over attacker-supplied bytes, and the
/// error names the mismatch instead of reporting a signature failure for a
/// statement whose problem was never the signature.
pub fn verify(
    statement_bytes: &[u8],
    signature: &[u8],
    expected_from: &KeyId,
) -> anyhow::Result<GrantStatement> {
    let st: GrantStatement = serde_json::from_slice(statement_bytes)?;
    if st.v != 5 {
        anyhow::bail!("unsupported grant version {}", st.v);
    }
    if &st.from != expected_from {
        anyhow::bail!("grant `from` does not match the expected issuer");
    }
    if st.from == st.to {
        anyhow::bail!("a key cannot grant to itself");
    }
    if st.expires_at <= st.issued_at {
        anyhow::bail!("expires_at must be after issued_at; every grant expires");
    }
    expected_from.verify(statement_bytes, signature)?;
    Ok(st)
}

/// A `follow`'s acceptance or denial, signed by the key the grant names as
/// `to` — its own statement, not a second grant, so a follower can prove its
/// access was granted without the hub vouching for it.
///
/// `kind` is one of exactly two `&'static` literals, `"accept"` or `"deny"`:
/// `verify_decision` is the only way to produce one, and it rejects any
/// other wire value before this type ever exists, so a caller holding a
/// `DecisionStatement` never needs to re-check `kind` against the open set
/// of possible strings.
#[derive(Clone, Debug, Serialize)]
pub struct DecisionStatement {
    pub v: u8,
    pub kind: &'static str,
    pub grant_id: String,
    pub by: KeyId,
    pub at: i64,
}

/// Wire shape for a `DecisionStatement`. `kind` is a plain `String` here
/// because serde's derive cannot deserialize into `&'static str` — that
/// name only exists on the validated `DecisionStatement` `verify_decision`
/// hands back, once `kind` has been checked against the known set.
#[derive(Deserialize)]
struct RawDecisionStatement {
    v: u8,
    kind: String,
    grant_id: String,
    by: KeyId,
    at: i64,
}

/// Verify a decision statement was signed by `expected_by`. Mirrors `verify`
/// above: the `by` field is attacker-controlled content, so it is checked
/// against `expected_by` BEFORE the cryptographic check, exactly the same
/// shape as `verify`'s `st.from == expected_from` guard. Callers still need
/// to check `grant_id` against the grant they are applying this decision
/// to — this function only knows the bytes it was handed, not which grant
/// row a caller intends to mutate.
pub fn verify_decision(
    statement_bytes: &[u8],
    signature: &[u8],
    expected_by: &KeyId,
) -> anyhow::Result<DecisionStatement> {
    let raw: RawDecisionStatement = serde_json::from_slice(statement_bytes)?;
    if raw.v != 5 {
        anyhow::bail!("unsupported decision version {}", raw.v);
    }
    let kind: &'static str = match raw.kind.as_str() {
        "accept" => "accept",
        "deny" => "deny",
        other => anyhow::bail!("unsupported decision kind `{other}`"),
    };
    if &raw.by != expected_by {
        anyhow::bail!("decision `by` does not match the expected signer");
    }
    expected_by.verify(statement_bytes, signature)?;
    Ok(DecisionStatement { v: raw.v, kind, grant_id: raw.grant_id, by: raw.by, at: raw.at })
}

/// A grant's withdrawal, signed by the key the grant names as `from`.
///
/// Carries the revoked grant's `scope` — the whole reason this is a statement
/// and not a bare id. Spec:334 makes deleting `federation/data/peers/<vault_id>/`
/// a hard requirement on the client, and a client that has lost its local copy
/// of the grant cannot map an opaque `grant_id` to a `vault_id`. `scope` is
/// exactly the grant's own `scope` column: `Some(vault_id)` names the one
/// vault whose cached data must go; `None` means every vault owned by `by`,
/// the same "any vault this issuer owns" an unscoped grant meant.
///
/// The hub checks `scope` against the stored grant before writing (see
/// `V5Store::revoke_grant`). Without that check an issuer could sign a
/// revocation naming a vault its grant never covered, and a client honouring
/// spec:334 would delete peer data it holds under a DIFFERENT issuer's grant.
/// **The client cannot make that check from these bytes alone** — serde reads
/// a missing `scope` as `None`, so a parsed `None` is indistinguishable from a
/// truncated message. A client acting on `scope` must compare it against its
/// own stored copy of the grant, exactly as the hub does.
///
/// `kind` is the `&'static str` `"revoke"`, the same discipline
/// `DecisionStatement` uses: `verify_revocation` is the only way to produce
/// one and it rejects any other wire value first, so the `"accept"`/`"deny"`
/// domain and this one can never be confused for each other even though the
/// two statements share every other field name.
#[derive(Clone, Debug, Serialize)]
pub struct RevocationStatement {
    pub v: u8,
    pub kind: &'static str,
    pub grant_id: String,
    pub by: KeyId,
    pub scope: Option<String>,
    pub at: i64,
}

/// Wire shape for a `RevocationStatement`, for the same reason
/// `RawDecisionStatement` exists: serde's derive cannot deserialize into
/// `&'static str`.
#[derive(Deserialize)]
struct RawRevocationStatement {
    v: u8,
    kind: String,
    grant_id: String,
    by: KeyId,
    scope: Option<String>,
    at: i64,
}

/// Verify a revocation statement was signed by `expected_by`. Same shape as
/// `verify` and `verify_decision`: `by` is attacker-controlled content, so it
/// is checked against `expected_by` BEFORE the cryptographic check.
///
/// This function knows only the bytes it was handed. It does NOT know whether
/// `expected_by` is the revoked grant's `from`, nor whether `scope` matches
/// that grant — both belong to whatever holds the grant, which on this side is
/// the local grant store. Splitting it that way is deliberate: signature
/// validity and authorization are separate questions and neither should be
/// able to stand in for the other.
pub fn verify_revocation(
    statement_bytes: &[u8],
    signature: &[u8],
    expected_by: &KeyId,
) -> anyhow::Result<RevocationStatement> {
    let raw: RawRevocationStatement = serde_json::from_slice(statement_bytes)?;
    if raw.v != 5 {
        anyhow::bail!("unsupported revocation version {}", raw.v);
    }
    if raw.kind != "revoke" {
        anyhow::bail!("unsupported revocation kind `{}`", raw.kind);
    }
    if &raw.by != expected_by {
        anyhow::bail!("revocation `by` does not match the expected signer");
    }
    expected_by.verify(statement_bytes, signature)?;
    Ok(RevocationStatement {
        v: raw.v,
        kind: "revoke",
        grant_id: raw.grant_id,
        by: raw.by,
        scope: raw.scope,
        at: raw.at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use ed25519_dalek::{Signer, SigningKey};

    fn pair() -> (SigningKey, KeyId) {
        let sk = SigningKey::generate(&mut rand::thread_rng());
        let id = KeyId::from_pubkey(&sk.verifying_key());
        (sk, id)
    }

    fn statement(from: &KeyId, to: &KeyId, kind: GrantKind) -> GrantStatement {
        GrantStatement {
            v: 5, kind, from: from.clone(), to: to.clone(), scope: None,
            issued_at: 1_757_000_000,
            expires_at: 1_757_000_000 + kind.default_ttl_secs(),
            nonce: "ZmFrZS1ub25jZQ".into(),
        }
    }

    #[test]
    fn verifies_a_well_formed_grant() {
        let (sk_a, a) = pair();
        let (_, b) = pair();
        let bytes = canonical_bytes(&statement(&a, &b, GrantKind::Follow));
        let sig = sk_a.sign(&bytes);
        let out = verify(&bytes, &sig.to_bytes(), &a).unwrap();
        assert_eq!(out.to, b);
    }

    #[test]
    fn rejects_an_unsupported_version() {
        let (sk_a, a) = pair();
        let (_, b) = pair();
        let mut st = statement(&a, &b, GrantKind::Follow);
        st.v = 4;
        let bytes = canonical_bytes(&st);
        let sig = sk_a.sign(&bytes);
        let err = verify(&bytes, &sig.to_bytes(), &a).unwrap_err();
        assert!(err.to_string().contains("version"));
    }

    #[test]
    fn rejects_a_grant_signed_by_someone_other_than_from() {
        let (_, a) = pair();
        let (sk_m, _m) = pair();
        let (_, b) = pair();
        let bytes = canonical_bytes(&statement(&a, &b, GrantKind::Follow));
        let sig = sk_m.sign(&bytes);
        assert!(verify(&bytes, &sig.to_bytes(), &a).is_err());
    }

    /// The `from` field is attacker-controlled content, not the identity that
    /// actually produced the signature. A key must not be able to sign a
    /// statement claiming a DIFFERENT key as its issuer — that would let it
    /// forge an attribution to a principal that never signed anything. This
    /// is a distinct failure mode from `rejects_a_grant_signed_by_someone_
    /// other_than_from`: here the signature is genuinely valid and made by
    /// `expected_from` itself, so only the `st.from == expected_from` check
    /// (not the cryptographic check) can catch it.
    #[test]
    fn rejects_a_grant_whose_signer_forges_a_different_from_field() {
        let (sk_a, a) = pair();
        let (_, m) = pair();
        let (_, b) = pair();
        let bytes = canonical_bytes(&statement(&m, &b, GrantKind::Follow));
        let sig = sk_a.sign(&bytes);
        assert!(verify(&bytes, &sig.to_bytes(), &a).is_err());
    }

    /// A garbage signature can't distinguish "checked from first" from
    /// "checked signature first" by `is_err()` alone — both orders reject.
    /// The orderings differ in WHICH error comes back: checking `from`
    /// first never touches the malformed signature bytes at all, so the
    /// message names the issuer mismatch specifically, not a signature
    /// failure. That error is the whole property — see `verify`'s doc
    /// comment for why no ordering here can admit a wrong key.
    #[test]
    fn rejects_a_forged_from_field_without_ever_inspecting_the_malformed_signature() {
        let (_, a) = pair();
        let (_, m) = pair();
        let (_, b) = pair();
        let bytes = canonical_bytes(&statement(&m, &b, GrantKind::Follow));
        let garbage_sig = [0u8; 64];
        let err = verify(&bytes, &garbage_sig, &a).unwrap_err();
        assert!(
            err.to_string().contains("expected issuer"),
            "expected the `from` mismatch to be reported before the signature is ever checked, got: {err}"
        );
    }

    /// The pinned tamper byte (`len - 2`, the closing quote before the final
    /// `}`) corrupts the JSON string terminator, so `serde_json::from_slice`
    /// rejects it before `expected_from.verify` ever runs. This test pins
    /// parser strictness, not signature integrity — the signature property is
    /// covered separately by `rejects_a_syntactically_valid_but_resigned_statement`.
    #[test]
    fn rejects_bytes_that_are_not_valid_json() {
        let (sk_a, a) = pair();
        let (_, b) = pair();
        let bytes = canonical_bytes(&statement(&a, &b, GrantKind::Follow));
        let sig = sk_a.sign(&bytes);
        let mut tampered = bytes.clone();
        let last = tampered.len() - 2;
        tampered[last] ^= 0xff;
        assert!(verify(&tampered, &sig.to_bytes(), &a).is_err());
    }

    /// Unlike `rejects_bytes_that_are_not_valid_json` above, this tamper stays
    /// inside a string value — the bytes still parse as a well-formed,
    /// different `GrantStatement` — so a pass here can only come from the
    /// ed25519 check in `verify`, not from `serde_json::from_slice` rejecting it.
    #[test]
    fn rejects_a_syntactically_valid_but_resigned_statement() {
        let (sk_a, a) = pair();
        let (_, b) = pair();
        let bytes = canonical_bytes(&statement(&a, &b, GrantKind::Follow));
        let sig = sk_a.sign(&bytes);
        let mut tampered = bytes.clone();
        let pos = tampered
            .windows(4)
            .position(|w| w == b"ZmFr")
            .expect("nonce literal present in canonical bytes");
        tampered[pos] = b'A';
        assert_ne!(tampered, bytes);
        assert!(serde_json::from_slice::<GrantStatement>(&tampered).is_ok(), "tamper must stay valid JSON");
        assert!(verify(&tampered, &sig.to_bytes(), &a).is_err());
    }

    #[test]
    fn grant_id_is_stable_and_content_addressed() {
        let (_, a) = pair();
        let (_, b) = pair();
        let bytes = canonical_bytes(&statement(&a, &b, GrantKind::Follow));
        assert_eq!(grant_id(&bytes), grant_id(&bytes));
        assert_eq!(grant_id(&bytes).len(), 64, "hex sha256");
    }

    #[test]
    fn rejects_a_grant_with_no_expiry() {
        let (sk_a, a) = pair();
        let (_, b) = pair();
        let mut st = statement(&a, &b, GrantKind::Follow);
        st.expires_at = 0;
        let bytes = canonical_bytes(&st);
        let sig = sk_a.sign(&bytes);
        let err = verify(&bytes, &sig.to_bytes(), &a).unwrap_err();
        assert!(err.to_string().contains("expires_at"));
    }

    #[test]
    fn rejects_a_self_grant() {
        let (sk_a, a) = pair();
        let bytes = canonical_bytes(&statement(&a, &a, GrantKind::Link));
        let sig = sk_a.sign(&bytes);
        assert!(verify(&bytes, &sig.to_bytes(), &a).is_err());
    }

    #[test]
    fn ttls_match_the_spec() {
        assert_eq!(GrantKind::Link.default_ttl_secs(), 365 * 86_400);
        assert_eq!(GrantKind::Assoc.default_ttl_secs(), 365 * 86_400);
        assert_eq!(GrantKind::Follow.default_ttl_secs(), 90 * 86_400);
        assert_eq!(GrantKind::Peer.default_ttl_secs(), 90 * 86_400);
    }

    /// `link` carries full authority between keys; `assoc` carries none. This
    /// is one of the two invariants the whole two-key model exists to
    /// protect — merging them would hand an employer-governed key the
    /// ability to act as a personal one. Assert it directly, by name, rather
    /// than looping over the four kinds — a loop over a list only checks
    /// that the code agrees with the list, and the list is the thing that
    /// would be wrong.
    #[test]
    fn only_link_transfers_authority() {
        assert!(GrantKind::Link.transfers_authority());
        assert!(!GrantKind::Assoc.transfers_authority());
        assert!(!GrantKind::Follow.transfers_authority());
        assert!(!GrantKind::Peer.transfers_authority());
    }

    fn decision(grant_id: &str, by: &KeyId, kind: &'static str, at: i64) -> DecisionStatement {
        DecisionStatement { v: 5, kind, grant_id: grant_id.to_string(), by: by.clone(), at }
    }

    #[test]
    fn verifies_a_well_formed_decision() {
        let (sk_b, b) = pair();
        let bytes = canonical_bytes(&decision("some-grant-id", &b, "accept", 1_050));
        let sig = sk_b.sign(&bytes);
        let out = verify_decision(&bytes, &sig.to_bytes(), &b).unwrap();
        assert_eq!(out.kind, "accept");
        assert_eq!(out.grant_id, "some-grant-id");
    }

    #[test]
    fn rejects_an_unsupported_decision_version() {
        let (sk_b, b) = pair();
        let mut d = decision("g", &b, "accept", 1_050);
        d.v = 4;
        let bytes = canonical_bytes(&d);
        let sig = sk_b.sign(&bytes);
        let err = verify_decision(&bytes, &sig.to_bytes(), &b).unwrap_err();
        assert!(err.to_string().contains("version"));
    }

    #[test]
    fn rejects_an_unrecognised_decision_kind() {
        let (sk_b, b) = pair();
        // Hand-build JSON with a `kind` outside the known set, to prove
        // `verify_decision` rejects it rather than relying on callers to
        // check the string themselves.
        let json = format!(
            r#"{{"v":5,"kind":"maybe","grant_id":"g","by":"{}","at":1050}}"#,
            b.as_str()
        );
        let bytes = json.into_bytes();
        let sig = sk_b.sign(&bytes);
        let err = verify_decision(&bytes, &sig.to_bytes(), &b).unwrap_err();
        // Naming the rejected value, not just the word "kind". Every way this
        // call can fail says "kind" — serde's `missing field \`kind\`` for a
        // renamed field, and this bail — so the shorter assertion was met by
        // the very error it was meant to discriminate against.
        assert!(
            err.to_string().contains("unsupported decision kind `maybe`"),
            "expected the unknown kind to be rejected by name, got: {err}"
        );
    }

    /// The wire NAME of `kind`, pinned as a literal.
    ///
    /// Nothing above pins it. `rejects_an_unrecognised_decision_kind` asserts
    /// only that the error says "kind", which serde's own `missing field
    /// \`kind\`` also says; and a round-trip proves our serialiser agrees with
    /// our deserialiser, which holds for any name the two share. The hub is
    /// the party that has to agree, and it cannot see this file — so the
    /// literal is the contract, exactly as it is for `GrantStatement` in
    /// `serialises_with_the_exact_key_names_and_kind_values_the_hub_emits`.
    ///
    /// Whole-string equality rather than `contains`, because `canonical_bytes`
    /// is what gets SIGNED: field order is part of the wire shape here, not a
    /// formatting detail.
    #[test]
    fn a_decision_serialises_to_the_exact_hub_expected_wire_format() {
        let (_, b) = pair();
        let json = String::from_utf8(canonical_bytes(&decision("g1", &b, "accept", 1_050))).unwrap();
        assert_eq!(
            json,
            format!(r#"{{"v":5,"kind":"accept","grant_id":"g1","by":"{}","at":1050}}"#, b.as_str())
        );

        let denied = String::from_utf8(canonical_bytes(&decision("g1", &b, "deny", 1_050))).unwrap();
        assert_eq!(
            denied,
            format!(r#"{{"v":5,"kind":"deny","grant_id":"g1","by":"{}","at":1050}}"#, b.as_str())
        );
    }

    /// The `by` field is attacker-controlled content, just like `from` on a
    /// `GrantStatement` (see `rejects_a_grant_whose_signer_forges_a_
    /// different_from_field` above). A key must not be able to sign a
    /// decision claiming a DIFFERENT key made it — the signature here is
    /// genuinely valid and made by `expected_by` itself, so only the
    /// `d.by == expected_by` check (not the cryptographic check) can catch
    /// this forged attribution.
    #[test]
    fn rejects_a_decision_whose_signer_forges_a_different_by_field() {
        let (sk_x, x) = pair();
        let (_, b) = pair();
        let bytes = canonical_bytes(&decision("g", &b, "accept", 1_050));
        let sig = sk_x.sign(&bytes);
        assert!(verify_decision(&bytes, &sig.to_bytes(), &x).is_err());
    }

    #[test]
    fn rejects_a_decision_signed_by_someone_other_than_by() {
        let (_, b) = pair();
        let (sk_m, _m) = pair();
        let bytes = canonical_bytes(&decision("g", &b, "accept", 1_050));
        let sig = sk_m.sign(&bytes);
        assert!(verify_decision(&bytes, &sig.to_bytes(), &b).is_err());
    }

    fn revocation(grant_id: &str, by: &KeyId, scope: Option<&str>, at: i64) -> RevocationStatement {
        RevocationStatement {
            v: 5,
            kind: "revoke",
            grant_id: grant_id.to_string(),
            by: by.clone(),
            scope: scope.map(str::to_string),
            at,
        }
    }

    #[test]
    fn verifies_a_well_formed_revocation() {
        let (sk_a, a) = pair();
        let bytes = canonical_bytes(&revocation("g1", &a, Some("v1"), 1_100));
        let sig = sk_a.sign(&bytes);
        let out = verify_revocation(&bytes, &sig.to_bytes(), &a).unwrap();
        assert_eq!(out.grant_id, "g1");
        assert_eq!(out.scope.as_deref(), Some("v1"));
        assert_eq!(out.kind, "revoke");
    }

    /// An unscoped grant's revocation must survive the round trip as `None`
    /// and not collapse into `Some("")` or a dropped field — `None` is the
    /// instruction "every vault this issuer owns", not the absence of one.
    #[test]
    fn an_unscoped_revocation_verifies_and_keeps_its_null_scope() {
        let (sk_a, a) = pair();
        let bytes = canonical_bytes(&revocation("g1", &a, None, 1_100));
        let sig = sk_a.sign(&bytes);
        let out = verify_revocation(&bytes, &sig.to_bytes(), &a).unwrap();
        assert!(out.scope.is_none());
    }

    #[test]
    fn rejects_an_unsupported_revocation_version() {
        let (sk_a, a) = pair();
        let mut r = revocation("g1", &a, None, 1_100);
        r.v = 4;
        let bytes = canonical_bytes(&r);
        let sig = sk_a.sign(&bytes);
        let err = verify_revocation(&bytes, &sig.to_bytes(), &a).unwrap_err();
        assert!(err.to_string().contains("version"));
    }

    #[test]
    fn rejects_a_revocation_whose_signer_forges_a_different_by_field() {
        let (sk_x, x) = pair();
        let (_, a) = pair();
        let bytes = canonical_bytes(&revocation("g1", &a, None, 1_100));
        let sig = sk_x.sign(&bytes);
        assert!(verify_revocation(&bytes, &sig.to_bytes(), &x).is_err());
    }

    #[test]
    fn rejects_a_revocation_signed_by_someone_other_than_by() {
        let (_, a) = pair();
        let (sk_m, _m) = pair();
        let bytes = canonical_bytes(&revocation("g1", &a, None, 1_100));
        let sig = sk_m.sign(&bytes);
        assert!(verify_revocation(&bytes, &sig.to_bytes(), &a).is_err());
    }

    /// `DecisionStatement` and `RevocationStatement` share `v`, `grant_id`,
    /// `by` and `at`, and are signed by keys that are frequently both parties
    /// to the same grant. `kind` is the only thing separating the two
    /// domains, so a genuine, correctly-signed statement of one kind must be
    /// refused by the other's verifier — otherwise a followee's `deny` could
    /// be replayed as the issuer's revocation, or vice versa. Both directions,
    /// because a one-way check passes even if only one verifier looks.
    #[test]
    fn a_decision_and_a_revocation_are_not_interchangeable() {
        let (sk_a, a) = pair();

        let rev = canonical_bytes(&revocation("g1", &a, None, 1_100));
        let rev_sig = sk_a.sign(&rev);
        assert!(verify_revocation(&rev, &rev_sig.to_bytes(), &a).is_ok(), "fixture sanity");
        let err = verify_decision(&rev, &rev_sig.to_bytes(), &a).unwrap_err();
        assert!(err.to_string().contains("kind"), "got {err}");

        let dec = canonical_bytes(&decision("g1", &a, "deny", 1_100));
        let dec_sig = sk_a.sign(&dec);
        assert!(verify_decision(&dec, &dec_sig.to_bytes(), &a).is_ok(), "fixture sanity");
        let err = verify_revocation(&dec, &dec_sig.to_bytes(), &a).unwrap_err();
        assert!(err.to_string().contains("kind"), "got {err}");
    }

    /// The scope is inside the signed bytes, so changing it changes the
    /// signature's subject. Without this the field could be carried and never
    /// covered — a relay could rewrite which vault a client is told to
    /// delete, which is precisely the deletion spec:334 makes mandatory.
    #[test]
    fn rewriting_the_scope_invalidates_the_signature() {
        let (sk_a, a) = pair();
        let bytes = canonical_bytes(&revocation("g1", &a, Some("v1"), 1_100));
        let sig = sk_a.sign(&bytes);
        let tampered = canonical_bytes(&revocation("g1", &a, Some("v2"), 1_100));
        assert!(
            serde_json::from_slice::<RawRevocationStatement>(&tampered).is_ok(),
            "the tamper must stay well-formed, or the parser catches it instead of the signature"
        );
        assert!(verify_revocation(&tampered, &sig.to_bytes(), &a).is_err());
        assert!(verify_revocation(&bytes, &sig.to_bytes(), &a).is_ok());
    }

    /// Pinned literal comparison, not a round-trip — a round-trip through our
    /// own `GrantStatement` agrees with itself regardless of what the hub
    /// emits. This is the mechanism that has actually held `protocol_v5.rs`
    /// and `key_id.rs` in sync: a literal string, not discipline.
    #[test]
    fn serialises_with_the_exact_key_names_and_kind_values_the_hub_emits() {
        let (_, a) = pair();
        let (_, b) = pair();
        let st = statement(&a, &b, GrantKind::Follow);
        let json = String::from_utf8(canonical_bytes(&st)).unwrap();
        assert!(json.starts_with(r#"{"v":5,"kind":"follow","from":""#));
        assert!(json.contains(r#"","to":""#));
        assert!(json.contains(r#"","scope":null,"issued_at":1757000000,"expires_at":"#));
        assert!(json.contains(r#","nonce":"ZmFrZS1ub25jZQ"}"#));

        for kind in [GrantKind::Follow, GrantKind::Link, GrantKind::Assoc, GrantKind::Peer] {
            let json = String::from_utf8(canonical_bytes(&statement(&a, &b, kind))).unwrap();
            let expected = match kind {
                GrantKind::Follow => r#""kind":"follow""#,
                GrantKind::Link => r#""kind":"link""#,
                GrantKind::Assoc => r#""kind":"assoc""#,
                GrantKind::Peer => r#""kind":"peer""#,
            };
            assert!(json.contains(expected), "kind {kind:?} serialised as {json}");
        }
    }

    /// A statement actually produced and signed by the hub (sync-hub's
    /// `GrantStatement`, `SigningKey::from_bytes(&[9u8; 32])` as `from`,
    /// `SigningKey::from_bytes(&[11u8; 32])` as `to`, `GrantKind::Follow`),
    /// captured by running a throwaway test against `sync-hub/src/v5/grant.rs`
    /// that printed `canonical_bytes` and the ed25519 signature base64. Pasted
    /// in as a literal rather than composed here, so this test fails if the
    /// hub's wire shape drifts even though our own types still round-trip.
    #[test]
    fn deserialises_and_verifies_a_statement_produced_by_the_hub() {
        let from = KeyId::parse("z6MkwVDfCg9LbbY6xjH3EZk8YSFQZujV5Y4y1ZWeER9tDiN3").unwrap();
        let statement_b64 = "eyJ2Ijo1LCJraW5kIjoiZm9sbG93IiwiZnJvbSI6Ino2TWt3VkRmQ2c5TGJiWTZ4akgzRVprOFlTRlFadWpWNVk0eTFaV2VFUjl0RGlOMyIsInRvIjoiejZNa21OTDZ4a3NkRUpFTkdrOVoxcXFHc1k1bmpLUWRqVTFVaG5VRVV2V3lRVVZYIiwic2NvcGUiOm51bGwsImlzc3VlZF9hdCI6MTc1NzAwMDAwMCwiZXhwaXJlc19hdCI6MTc2NDc3NjAwMCwibm9uY2UiOiJabUZyWlMxdWIyNWpaUSJ9";
        let signature_b64 = "8jkQzbKFN753a17HTnXHuOreoh9EaHTZuwQfQLv2WhsR7tvoamK/mOlQbtQTWv4Ji2mQUUXhB5eEd4PPaHjABw==";
        let bytes = base64::engine::general_purpose::STANDARD.decode(statement_b64).unwrap();
        let sig = base64::engine::general_purpose::STANDARD.decode(signature_b64).unwrap();
        let st = verify(&bytes, &sig, &from).unwrap();
        assert_eq!(st.to.as_str(), "z6MkmNL6xksdEJENGk9Z1qqGsY5njKQdjU1UhnUEUvWyQUVX");
        assert_eq!(st.kind, GrantKind::Follow);
        assert_eq!(st.issued_at, 1_757_000_000);
    }
}
