//! Device linking: four doors, one grant.
//!
//! A machine is a key; a person is a set of keys joined by `link` grants.
//! This is how a second machine becomes yours. Four doors — a typed pairing
//! code, a QR, an offline paste blob, and the recovery key — all end in
//! [`issue_link_grant`], because the door is only how a string crosses the
//! gap between two screens.
//!
//! **The fingerprint is the security boundary in all four; the transport is
//! not.** Whatever a door parses produces a [`KeyId`] through `KeyId::parse`,
//! and the approver is shown `words::fingerprint` of that key before anything
//! is signed. A door that shows one key's words and signs another's is the
//! whole attack.
//!
//! **A `link` is two grants, not one grant signed twice.** A grant *is* one
//! key's statement about another and its signature is that key's; mutuality
//! is a property of a pair of statements. So `approve` produces A→B, signed
//! and lodged by A, and B — on finding it, in `SyncReady.grants` or in the
//! blob handed to it offline — produces B→A and signs that itself. Neither
//! machine can speak for the other before it has agreed to.
//!
//! **The offline door needs no hub.** Door 3 is the one that proves the hub
//! is a convenience and never an authority over who you are: the grant it
//! produces verifies with nothing but the bytes and the issuer's public key.
//! What the hub does hold is membership — it admits a non-member presenting a
//! key that holds an active `link` from a current member — so a machine
//! linked offline can act as itself immediately and reaches the hub once the
//! approver next connects and lodges what it signed.

use std::path::Path;

use anyhow::Context as _;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::client::{connect_and_authenticate, recv_json, send_json, unix_now, WsStream};
use super::config::{self, grants_path, FederationConfig, HubEndpoint, Identity, VisibilityConfig};
use super::grant::{self, canonical_bytes, GrantKind, GrantStatement};
use super::handshake::{b64, random_nonce};
use super::key_id::KeyId;
use super::protocol_v5::{ClientMsg, GrantWire, HubMsg, PROTOCOL_VERSION};
use super::{seed_store, well_known, words};

const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Tags the two strings a door puts on a screen. A string that came from
/// somewhere else fails here, where the error can say what it wanted, rather
/// than three layers down where it can only say the bytes were wrong.
const PAIRING_TAG: &str = "ll-link-v5";
const GRANT_TAG: &str = "ll-grant-v5";

/// Base58 characters of `sha256(key_id)` carried alongside the key in a
/// pairing code.
///
/// The code is the one thing crossing the gap that carries no signature — a
/// grant blob is self-authenticating, a pairing code is a bare public key —
/// so a single mistyped character would otherwise decode to a *different,
/// perfectly valid* key: roughly half of all 32-byte strings are points on
/// the curve, and `KeyId::parse` rightly accepts every one of them. Six
/// base58 characters is ~35 bits, which turns a typo into a parse error.
///
/// It is not a defence against substitution. Anyone who can replace the code
/// can recompute the check; the six words are what catch that.
const CHECK_LEN: usize = 6;

/// A grant statement and the signature over exactly those bytes.
#[derive(Clone, Debug)]
pub struct SignedGrant {
    pub statement: Vec<u8>,
    pub signature: Vec<u8>,
}

/// What the joining machine shows, and what the approver reads back to it.
#[derive(Clone, Debug)]
pub struct PendingLink {
    pub joining_key: KeyId,
    /// Six words over the joining key. Both ends print this from the same
    /// `KeyId`; comparing them is what a hostile hub cannot survive.
    pub fingerprint: String,
    /// The typed pairing code — Door 1. Door 2 is this string as a QR, Door 3
    /// is this string pasted.
    pub code: String,
}

impl PendingLink {
    pub fn for_key(joining_key: KeyId) -> Self {
        PendingLink {
            fingerprint: words::fingerprint(&joining_key),
            code: pairing_code(&joining_key),
            joining_key,
        }
    }

    /// Door 2. The same string as Door 1, drawn instead of typed — a
    /// pairing code carries a 48-character `key_id` and there is no shorter
    /// honest form of it now that the hub holds no pending state to look one
    /// up in.
    pub fn qr(&self) -> anyhow::Result<String> {
        let code = qrcode::QrCode::new(self.code.as_bytes())
            .context("pairing code does not fit in a QR")?;
        Ok(code
            .render::<qrcode::render::unicode::Dense1x2>()
            .quiet_zone(true)
            .build())
    }
}

/// The one confirmation this module cannot make on the user's behalf: six
/// words read off a screen it cannot see.
pub trait Approve {
    /// `subject` names what the words describe. Returning false aborts, and
    /// nothing has been signed or written at that point.
    fn confirm(&mut self, subject: &str, fingerprint: &str) -> anyhow::Result<bool>;
}

/// Prompts on stderr, reads from stdin. Anything but an explicit yes — a
/// blank line, EOF, a closed pipe — is a no.
pub struct TtyApprove;

impl Approve for TtyApprove {
    fn confirm(&mut self, subject: &str, fingerprint: &str) -> anyhow::Result<bool> {
        use std::io::{BufRead, Write};
        eprintln!();
        eprintln!("  {subject}: {fingerprint}");
        eprintln!();
        eprintln!("These six words are computed from the key itself. Confirm they match");
        eprintln!("what the other screen is showing before you admit it.");
        eprint!("Do they match? [y/N] ");
        std::io::stderr().flush()?;
        let mut line = String::new();
        if std::io::stdin().lock().read_line(&mut line)? == 0 {
            return Ok(false);
        }
        Ok(matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes"))
    }
}

/// Every door ends here. If a door does not call this, it is not a door — it
/// is a second implementation, and the two will drift.
fn issue_link_grant(
    approver: &SigningKey,
    joiner: &KeyId,
    now: i64,
) -> anyhow::Result<SignedGrant> {
    let from = KeyId::from_pubkey(&approver.verifying_key());
    if &from == joiner {
        anyhow::bail!("a machine cannot link to itself");
    }
    let st = GrantStatement {
        v: 5,
        kind: GrantKind::Link,
        from,
        to: joiner.clone(),
        // Unscoped: a device link is full authority. A scope would name one
        // vault, and this key is not a peer being let into one vault — it is
        // the same person at another keyboard.
        scope: None,
        issued_at: now,
        expires_at: now + GrantKind::Link.default_ttl_secs(),
        nonce: b64(&random_nonce()),
    };
    let statement = canonical_bytes(&st);
    let signature = approver.sign(&statement).to_bytes().to_vec();
    Ok(SignedGrant { statement, signature })
}

/// Check a grant against nothing but its own bytes.
///
/// The issuer is read out of the statement and the signature verified against
/// it — self-authenticating, the same way the hub treats one. That is what
/// makes Door 3 mean anything: no hub is consulted, and none could change the
/// answer.
pub fn verify_grant(g: &SignedGrant) -> anyhow::Result<GrantStatement> {
    let named_from = serde_json::from_slice::<GrantStatement>(&g.statement)
        .context("grant statement does not parse")?
        .from;
    grant::verify(&g.statement, &g.signature, &named_from)
}

fn check_chars(key_id: &KeyId) -> String {
    let digest = Sha256::digest(key_id.as_str().as_bytes());
    bs58::encode(&digest[..8])
        .into_string()
        .chars()
        .take(CHECK_LEN)
        .collect()
}

/// The string a joining machine shows and an approver types.
pub fn pairing_code(key_id: &KeyId) -> String {
    format!("{PAIRING_TAG}.{}.{}", key_id.as_str(), check_chars(key_id))
}

/// Read a pairing code back. Rejects anything that is not this exact shape,
/// and anything whose check characters do not match the key it carries.
pub fn parse_pairing_code(code: &str) -> anyhow::Result<KeyId> {
    let mut parts = code.trim().split('.');
    let (Some(tag), Some(body), Some(check), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        anyhow::bail!("not a pairing code: expected {PAIRING_TAG}.<key_id>.<check>");
    };
    if tag != PAIRING_TAG {
        anyhow::bail!("not a pairing code: expected the {PAIRING_TAG} tag, got {tag:?}");
    }
    let key_id = KeyId::parse(body).context("pairing code does not carry a usable key_id")?;
    if check != check_chars(&key_id) {
        anyhow::bail!(
            "pairing code failed its check characters — it was mistyped or truncated. \
             Read it again rather than trusting it: a code one character out can name a \
             different, entirely valid key."
        );
    }
    Ok(key_id)
}

/// The paste form of a signed grant. No check characters: the signature over
/// the statement already fails on any corruption, and it fails for the right
/// reason.
pub fn grant_blob(g: &SignedGrant) -> String {
    format!("{GRANT_TAG}.{}.{}", B64.encode(&g.statement), B64.encode(&g.signature))
}

pub fn parse_grant_blob(blob: &str) -> anyhow::Result<SignedGrant> {
    let mut parts = blob.trim().split('.');
    let (Some(tag), Some(statement), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        anyhow::bail!("not a grant blob: expected {GRANT_TAG}.<statement>.<signature>");
    };
    if tag != GRANT_TAG {
        anyhow::bail!("not a grant blob: expected the {GRANT_TAG} tag, got {tag:?}");
    }
    Ok(SignedGrant {
        statement: B64.decode(statement).context("grant statement is not base64")?,
        signature: B64.decode(signature).context("grant signature is not base64")?,
    })
}

// ---------------------------------------------------------------------------
// The local store
// ---------------------------------------------------------------------------

/// One row of `federation/grants.json`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredGrant {
    pub statement_b64: String,
    pub signature_b64: String,
    /// Whether the hub has acknowledged this grant. A grant signed through
    /// the offline door has no hub to tell until some later connection, and a
    /// machine that forgot which ones it still owed would either re-send
    /// everything forever or never send the one that mattered.
    #[serde(default)]
    pub lodged: bool,
}

impl StoredGrant {
    fn signed(&self) -> anyhow::Result<SignedGrant> {
        Ok(SignedGrant {
            statement: B64.decode(&self.statement_b64).context("stored statement is not base64")?,
            signature: B64.decode(&self.signature_b64).context("stored signature is not base64")?,
        })
    }
}

pub fn load_grants(config_dir: &Path) -> anyhow::Result<Vec<StoredGrant>> {
    let path = grants_path(config_dir);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .with_context(|| format!("{} is not a readable grant store", path.display())),
        // No file is no grants. Every other read error is a real one: a store
        // this machine cannot read is not a machine with no links.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(anyhow::Error::new(e).context(format!("reading {}", path.display()))),
    }
}

fn save_grants(config_dir: &Path, grants: &[StoredGrant]) -> anyhow::Result<()> {
    let path = grants_path(config_dir);
    std::fs::create_dir_all(config_dir.join("federation"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(grants)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Add a grant to the store unless the same statement is already there.
/// Returns whether it was new. Identity is `grant_id` — the hash of the
/// statement bytes — which is the same identity the hub gives it.
fn remember(config_dir: &Path, g: &SignedGrant, lodged: bool) -> anyhow::Result<bool> {
    let mut grants = load_grants(config_dir)?;
    let id = grant::grant_id(&g.statement);
    if let Some(existing) = grants
        .iter_mut()
        .find(|s| s.signed().map(|sg| grant::grant_id(&sg.statement) == id).unwrap_or(false))
    {
        existing.lodged |= lodged;
        save_grants(config_dir, &grants)?;
        return Ok(false);
    }
    grants.push(StoredGrant {
        statement_b64: B64.encode(&g.statement),
        signature_b64: B64.encode(&g.signature),
        lodged,
    });
    save_grants(config_dir, &grants)?;
    Ok(true)
}

/// Every stored grant whose signature still checks out and whose expiry has
/// not passed.
///
/// A row that does not verify is reported and skipped rather than fatal: this
/// file is the machine's own record of what it signed, and one unreadable row
/// must not make the rest of a person's machines unusable. Silence would be
/// worse than either — that is how a link disappears with nobody noticing.
fn active_grants(
    config_dir: &Path,
    now: i64,
) -> anyhow::Result<Vec<(StoredGrant, GrantStatement)>> {
    let mut out = Vec::new();
    for stored in load_grants(config_dir)? {
        let signed = match stored.signed() {
            Ok(s) => s,
            Err(e) => {
                eprintln!("skipping an unreadable row in the grant store: {e}");
                continue;
            }
        };
        match verify_grant(&signed) {
            Ok(st) if st.expires_at > now => out.push((stored, st)),
            Ok(_) => {}
            Err(e) => eprintln!("skipping a stored grant that does not verify: {e}"),
        }
    }
    Ok(out)
}

fn local_signing_key(config_dir: &Path) -> anyhow::Result<SigningKey> {
    Ok(seed_store::load_only(config_dir)?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no identity in {} — only an established key can admit a new machine. \
                 Run `ll join` here first.",
                config_dir.display()
            )
        })?
        .signing_key)
}

fn local_key_id(config_dir: &Path) -> anyhow::Result<KeyId> {
    Ok(KeyId::from_pubkey(&local_signing_key(config_dir)?.verifying_key()))
}

/// Make sure this machine has issued an active `link` to `other`, signing one
/// if it has not.
///
/// Both halves of a completed link come through here — the reciprocal a
/// joiner owes whoever admitted it, and the grant the recovery key holds —
/// because they are the same sentence with a different subject, and a second
/// copy of it would be a second thing to keep correct.
fn ensure_link_to(config_dir: &Path, other: &KeyId, now: i64) -> anyhow::Result<bool> {
    let me = local_key_id(config_dir)?;
    if &me == other {
        return Ok(false);
    }
    let already = active_grants(config_dir, now)?
        .iter()
        .any(|(_, st)| st.kind == GrantKind::Link && st.from == me && &st.to == other);
    if already {
        return Ok(false);
    }
    let signed = issue_link_grant(&local_signing_key(config_dir)?, other, now)?;
    remember(config_dir, &signed, false)?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// The doors
// ---------------------------------------------------------------------------

/// Door 3's joining half, and the source of Door 2's QR: this machine's
/// pairing code, over no network at all.
///
/// Creates the identity if there is not one yet, which is the whole of what a
/// new machine needs before it can be admitted.
pub fn request_offline(config_dir: &Path) -> anyhow::Result<String> {
    Ok(pending_offline(config_dir)?.code)
}

/// The same, with the six words this machine must show beside the code.
pub fn pending_offline(config_dir: &Path) -> anyhow::Result<PendingLink> {
    let identity = seed_store::load_or_create(config_dir)?;
    Ok(PendingLink::for_key(KeyId::from_pubkey(&identity.signing_key.verifying_key())))
}

/// Door 1's joining half: the same pairing code, plus everything this machine
/// needs to reach the hub once it has been admitted.
///
/// It deliberately does not connect. A key nobody has linked yet is refused
/// at `ClientHello` — that is the hub doing its job — so the only useful
/// thing to take from the hub now is its published identity, which is a plain
/// HTTP document and is pinned here exactly as `ll join` pins it.
pub async fn request(
    config_dir: &Path,
    hub_endpoint: &str,
    vault_path: &Path,
    confirm: &mut dyn Approve,
) -> anyhow::Result<PendingLink> {
    let config_path = config::config_path(config_dir);
    if config_path.exists() {
        anyhow::bail!(
            "{} already exists — this machine has a hub already. Use `ll link code` to \
             show its pairing code instead; linking an established key does not need a \
             second config.",
            config_path.display()
        );
    }
    super::join::require_a_profile_if_this_is_not_the_root(config_dir)?;
    super::client::check_hub_scheme(hub_endpoint)?;

    let hub = well_known::fetch(hub_endpoint).await?;
    if hub.protocol_version != PROTOCOL_VERSION {
        anyhow::bail!(
            "hub speaks protocol v{}, this client speaks v{PROTOCOL_VERSION}. \
             There is no negotiation and no downgrade; upgrade one side.",
            hub.protocol_version
        );
    }
    let hub_key = KeyId::parse(&hub.hub_key_id)?;
    if !confirm.confirm("hub identity", &words::fingerprint(&hub_key))? {
        anyhow::bail!("hub fingerprint not confirmed; nothing was written");
    }

    let identity = seed_store::load_or_create(config_dir)?;
    let joining_key = KeyId::from_pubkey(&identity.signing_key.verifying_key());

    config::write_config(
        config_dir,
        &FederationConfig {
            identity: Identity {
                display_name: super::join::display_name_for(vault_path),
                pubkey: super::auth::pubkey_b64(&identity.signing_key),
            },
            visibility: VisibilityConfig { default: "private".into(), rules: Vec::new() },
            hub: HubEndpoint {
                endpoint: hub_endpoint.to_string(),
                key_id: Some(hub.hub_key_id.clone()),
            },
            graph: false,
            vault_id: Some(uuid::Uuid::now_v7().to_string()),
            vault_path: Some(vault_path.display().to_string()),
            // Belongs to the person, and the person already has one. Only the
            // enrollment that generated the 24 words can record it.
            recovery_key_id: None,
        },
    )?;

    Ok(PendingLink::for_key(joining_key))
}

/// Doors 1 and 2, the approving half: read the code, confirm the six words,
/// sign the grant, and lodge it so the joining machine can collect it from
/// `SyncReady.grants` on its next connection.
///
/// Door 1 is Door 3 plus a network step, and it is written that way on
/// purpose — the grant is identical, and the only difference between the
/// doors is who carries it.
pub async fn approve(
    config_dir: &Path,
    code: &str,
    confirm: &mut dyn Approve,
) -> anyhow::Result<()> {
    approve_offline(config_dir, code, confirm)?;
    connect_and_reconcile(config_dir).await?;
    Ok(())
}

/// Door 3, the approving half: the same grant, handed back as a blob to carry
/// across on whatever the two machines have.
///
/// The grant is stored here before it is lodged anywhere, and that order is
/// deliberate. A grant on the hub that this machine has no record of is one
/// it cannot revoke by name; a grant on disk that the hub has not seen is
/// re-sent by the next connection. Only one of those two failures is
/// recoverable.
pub fn approve_offline(
    config_dir: &Path,
    blob: &str,
    confirm: &mut dyn Approve,
) -> anyhow::Result<String> {
    let joiner = parse_pairing_code(blob)?;
    let approver = local_signing_key(config_dir)?;
    if !confirm.confirm("new machine", &words::fingerprint(&joiner))? {
        anyhow::bail!("fingerprint not confirmed; nothing was signed");
    }
    let signed = issue_link_grant(&approver, &joiner, unix_now())?;
    remember(config_dir, &signed, false)?;
    Ok(grant_blob(&signed))
}

/// Door 3, the joining half: take a grant handed over offline, check it with
/// nothing but its own bytes, and answer it.
///
/// The reciprocal is signed here rather than waiting for a connection,
/// because offline is the whole point of this door — there is no
/// `SyncReady.grants` coming to learn the other key from.
pub fn accept_offline(config_dir: &Path, grant_blob: &str) -> anyhow::Result<()> {
    let signed = parse_grant_blob(grant_blob)?;
    let st = verify_grant(&signed)?;
    let me = local_key_id(config_dir)?;
    if st.kind != GrantKind::Link {
        anyhow::bail!("this is a {:?} grant, not a link; it admits no machine", st.kind);
    }
    if st.to != me {
        anyhow::bail!(
            "this grant admits {}, and this machine is {}. Nothing was stored.",
            st.to.as_str(),
            me.as_str()
        );
    }
    let now = unix_now();
    if st.expires_at <= now {
        anyhow::bail!("this link grant expired at {}; ask for a fresh one", st.expires_at);
    }
    remember(config_dir, &signed, false)?;
    ensure_link_to(config_dir, &st.from, now)?;
    Ok(())
}

/// Door 4's issuing half: the recovery key holds a `link` from this machine,
/// so that restoring the 24 words later produces a key that is already one of
/// this person's and has nobody left to ask.
///
/// Issued from `recovery_key_id`, which `ll join` recorded — the public half
/// is all that is needed, and the secret half exists only as the words.
fn ensure_recovery_link(
    config_dir: &Path,
    config: &FederationConfig,
    now: i64,
) -> anyhow::Result<bool> {
    let Some(recorded) = config.recovery_key_id.as_deref() else {
        return Ok(false);
    };
    let recovery = KeyId::parse(recorded).context("recovery_key_id in config.json is unusable")?;
    ensure_link_to(config_dir, &recovery, now)
}

// ---------------------------------------------------------------------------
// The hub half
// ---------------------------------------------------------------------------

async fn lodge_one(ws: &mut WsStream, stored: &StoredGrant) -> anyhow::Result<()> {
    let signed = stored.signed()?;
    send_json(
        ws,
        &ClientMsg::PutGrant {
            statement_b64: stored.statement_b64.clone(),
            signature_b64: stored.signature_b64.clone(),
        },
    )
    .await?;
    match recv_json::<HubMsg>(ws).await? {
        HubMsg::GrantAck { grant_id } => {
            let expected = grant::grant_id(&signed.statement);
            if grant_id != expected {
                anyhow::bail!(
                    "hub acknowledged {grant_id} for a grant whose id is {expected}; \
                     it stored something other than what was sent"
                );
            }
            Ok(())
        }
        HubMsg::Reject { reason } => anyhow::bail!("hub refused a grant: {reason}"),
        other => anyhow::bail!("expected grant-ack, got {other:?}"),
    }
}

/// Send every grant the hub has not acknowledged yet.
async fn lodge_all(ws: &mut WsStream, config_dir: &Path) -> anyhow::Result<usize> {
    let mut grants = load_grants(config_dir)?;
    let mut lodged = 0usize;
    let mut outcome = Ok(());
    for stored in grants.iter_mut().filter(|g| !g.lodged) {
        match lodge_one(ws, stored).await {
            Ok(()) => {
                stored.lodged = true;
                lodged += 1;
            }
            Err(e) => {
                outcome = Err(e);
                break;
            }
        }
    }
    // Record the acknowledgements even on the way out of a failure. Re-sending
    // a lodged grant is a no-op on the hub, but a machine that forgets an ack
    // it received keeps a row marked owed forever.
    save_grants(config_dir, &grants)?;
    outcome?;
    Ok(lodged)
}

/// Everything a connection owes this person's key graph, over a connection
/// somebody else opened.
///
/// Runs before anything vault-shaped in a sync cycle: a machine that has just
/// been linked may hold nothing else worth uploading, and its half of the
/// link still has to complete.
pub(super) async fn reconcile(
    ws: &mut WsStream,
    config_dir: &Path,
    config: &FederationConfig,
    grants: &[GrantWire],
    now: i64,
) -> anyhow::Result<()> {
    let me = local_key_id(config_dir)?;
    for wire in grants {
        if wire.state != "active" {
            continue;
        }
        let (Ok(statement), Ok(signature)) =
            (B64.decode(&wire.statement_b64), B64.decode(&wire.signature_b64))
        else {
            eprintln!("skipping a grant that is not valid base64");
            continue;
        };
        let signed = SignedGrant { statement, signature };
        let st = match verify_grant(&signed) {
            Ok(st) => st,
            Err(e) => {
                eprintln!("skipping a grant that does not verify: {e}");
                continue;
            }
        };
        if st.kind != GrantKind::Link || st.expires_at <= now {
            continue;
        }
        if st.to != me && st.from != me {
            continue;
        }
        // The hub has it by definition — it just sent it. Taking back the
        // OUTBOUND half too is what stops a machine that lost its store from
        // signing a second grant for a relationship it already has: the store
        // is this key's only memory of what it issued, and `SyncReady` carries
        // both directions.
        remember(config_dir, &signed, true)?;
        if st.to == me && ensure_link_to(config_dir, &st.from, now)? {
            eprintln!("Answered a link from {} with its reciprocal", st.from.as_str());
        }
    }
    ensure_recovery_link(config_dir, config, now)?;
    let lodged = lodge_all(ws, config_dir).await?;
    if lodged > 0 {
        eprintln!("Lodged {lodged} grant(s) with the hub");
    }
    Ok(())
}

/// [`reconcile`] over a connection of its own, for the commands that are not
/// a sync cycle.
pub async fn connect_and_reconcile(config_dir: &Path) -> anyhow::Result<()> {
    let config = config::load_config(config_dir)?;
    let signing_key = local_signing_key(config_dir)?;
    let (mut ws, ready) = connect_and_authenticate(
        &config,
        &signing_key,
        &config.identity.display_name,
        "unknown",
        None,
    )
    .await?;
    let outcome = reconcile(&mut ws, config_dir, &config, &ready.grants, unix_now()).await;
    let _ = futures_util::SinkExt::close(&mut ws).await;
    outcome
}

/// One line per link this machine knows about, for `ll link list`.
#[derive(Debug, Serialize)]
pub struct LinkRow {
    pub other: String,
    pub fingerprint: String,
    /// `inbound` if the other key admitted this one, `outbound` if this one
    /// admitted it, `mutual` once both halves exist.
    pub direction: &'static str,
    pub expires_at: i64,
    pub lodged: bool,
}

pub fn list(config_dir: &Path) -> anyhow::Result<Vec<LinkRow>> {
    let me = local_key_id(config_dir)?;
    let now = unix_now();
    let mut rows: Vec<LinkRow> = Vec::new();
    for (stored, st) in active_grants(config_dir, now)? {
        if st.kind != GrantKind::Link {
            continue;
        }
        let (other, direction) = if st.to == me {
            (st.from.clone(), "inbound")
        } else if st.from == me {
            (st.to.clone(), "outbound")
        } else {
            continue;
        };
        let lodged = stored.lodged;
        match rows.iter_mut().find(|r| r.other == other.as_str()) {
            Some(existing) => {
                if existing.direction != direction {
                    existing.direction = "mutual";
                }
                existing.expires_at = existing.expires_at.min(st.expires_at);
                existing.lodged &= lodged;
            }
            None => rows.push(LinkRow {
                fingerprint: words::fingerprint(&other),
                other: other.as_str().to_string(),
                direction,
                expires_at: st.expires_at,
                lodged,
            }),
        }
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::test_hub::{self, GrantAnswer};
    use std::path::PathBuf;
    use tempfile::TempDir;

    /// A machine whose signing key is `seed`, planted rather than generated so
    /// four doors can be run from four clean directories and still be the same
    /// approver. `write_encrypted` is the backend `force_encrypted_seed_backend`
    /// pins the whole binary to.
    fn dir_with_seed(seed: u8) -> TempDir {
        test_hub::force_encrypted_seed_backend();
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("federation")).unwrap();
        seed_store::write_encrypted(dir.path(), &[seed; 32]).unwrap();
        dir
    }

    fn seeded_dir() -> TempDir {
        dir_with_seed(7)
    }

    /// A directory with an identity of its own but nothing else — what a new
    /// machine looks like the moment before it shows a pairing code.
    fn fresh_dir() -> TempDir {
        test_hub::force_encrypted_seed_backend();
        tempfile::tempdir().unwrap()
    }

    fn key(seed: u8) -> KeyId {
        KeyId::from_pubkey(&SigningKey::from_bytes(&[seed; 32]).verifying_key())
    }

    fn key_of(dir: &Path) -> KeyId {
        local_key_id(dir).unwrap()
    }

    fn write_hub_config(dir: &Path, ws_url: &str, recovery: Option<&KeyId>) {
        config::write_config(
            dir,
            &FederationConfig {
                identity: Identity {
                    display_name: "test".into(),
                    pubkey: "ed25519:AAAA".into(),
                },
                visibility: VisibilityConfig { default: "private".into(), rules: Vec::new() },
                hub: HubEndpoint {
                    endpoint: ws_url.to_string(),
                    key_id: Some(test_hub::hub_key_id_str()),
                },
                graph: false,
                vault_id: Some("v1".into()),
                vault_path: None,
                recovery_key_id: recovery.map(|k| k.as_str().to_string()),
            },
        )
        .unwrap();
    }

    /// Records every fingerprint it was shown, and says yes.
    #[derive(Default)]
    struct Yes {
        shown: Vec<(String, String)>,
    }

    impl Approve for Yes {
        fn confirm(&mut self, subject: &str, fingerprint: &str) -> anyhow::Result<bool> {
            self.shown.push((subject.to_string(), fingerprint.to_string()));
            Ok(true)
        }
    }

    struct No;

    impl Approve for No {
        fn confirm(&mut self, _subject: &str, _fingerprint: &str) -> anyhow::Result<bool> {
            Ok(false)
        }
    }

    /// Whether some established key has admitted this machine.
    ///
    /// An *inbound* link, deliberately: what makes a machine one of a
    /// person's is that another of them said so, and what this machine has
    /// issued says nothing about its own standing.
    ///
    /// A test helper rather than module surface. It was `pub` and no
    /// production code called it — an abstraction with no concrete caller.
    /// `ll doctor` (Plan 8) is the caller it is waiting for; it belongs back
    /// in the module the day that exists, and not before.
    fn has_active_link(config_dir: &Path) -> anyhow::Result<bool> {
        let me = local_key_id(config_dir)?;
        Ok(active_grants(config_dir, unix_now())?
            .iter()
            .any(|(_, st)| st.kind == GrantKind::Link && st.to == me))
    }

    /// Whether both halves of the link between this machine and `other`
    /// exist here. A machine holding only the inbound half has been admitted
    /// and has not yet answered; it cannot act for `other` until it has said
    /// so itself. Same story as `has_active_link`: no production caller, so
    /// it lives with the tests that assert on it.
    fn is_mutual(config_dir: &Path, other: &KeyId) -> anyhow::Result<bool> {
        let me = local_key_id(config_dir)?;
        let grants = active_grants(config_dir, unix_now())?;
        let links_to = |from: &KeyId, to: &KeyId| {
            grants
                .iter()
                .any(|(_, st)| st.kind == GrantKind::Link && &st.from == from && &st.to == to)
        };
        Ok(links_to(other, &me) && links_to(&me, other))
    }

    fn wire_to_signed(wire: &GrantWire) -> SignedGrant {
        SignedGrant {
            statement: B64.decode(&wire.statement_b64).unwrap(),
            signature: B64.decode(&wire.signature_b64).unwrap(),
        }
    }

    /// The grant this machine holds naming `to`, straight out of its store.
    fn stored_grant_to(dir: &Path, to: &KeyId) -> SignedGrant {
        load_grants(dir)
            .unwrap()
            .iter()
            .map(|s| s.signed().unwrap())
            .find(|g| verify_grant(g).map(|st| &st.to == to).unwrap_or(false))
            .expect("no stored grant names that key")
    }

    // -- the four doors ----------------------------------------------------

    /// Door 1: the approver types the code and the grant goes to the hub. The
    /// grant this returns is the one that actually reached the hub, not the
    /// one we hoped was sent.
    async fn grant_from_hub_door(approver: &Path, joiner: &KeyId) -> SignedGrant {
        let (hub, lodged) = test_hub::spawn_grant_hub(vec![], vec![]).await;
        write_hub_config(approver, &hub.ws_url(), None);
        approve(approver, &pairing_code(joiner), &mut Yes::default()).await.unwrap();
        let wire = lodged.lock().unwrap().clone();
        assert_eq!(wire.len(), 1, "the approver lodged {} grants, not one", wire.len());
        wire_to_signed(&wire[0])
    }

    /// Door 2: the same string, drawn instead of typed. Nothing here decodes
    /// a QR — the payload IS `pending.code` by construction — so what this
    /// asserts is that the code fits and renders, and that approving from it
    /// lands in the same place Door 1 does.
    async fn grant_from_qr_door(approver: &Path, joiner: &KeyId) -> SignedGrant {
        let pending = PendingLink::for_key(joiner.clone());
        let qr = pending.qr().expect("a pairing code must fit in a QR");
        assert!(qr.lines().count() > 10, "a rendered QR is more than a couple of lines");
        let (hub, lodged) = test_hub::spawn_grant_hub(vec![], vec![]).await;
        write_hub_config(approver, &hub.ws_url(), None);
        approve(approver, &pending.code, &mut Yes::default()).await.unwrap();
        let wire = lodged.lock().unwrap().clone();
        assert_eq!(wire.len(), 1);
        wire_to_signed(&wire[0])
    }

    /// Door 3: no hub anywhere in this function.
    fn grant_from_offline_door(approver: &Path, joiner: &KeyId) -> SignedGrant {
        let blob =
            approve_offline(approver, &pairing_code(joiner), &mut Yes::default()).unwrap();
        parse_grant_blob(&blob).unwrap()
    }

    /// Door 4: the recovery key. Nobody approves — the grant is issued when
    /// the machine that generated the words is still the machine.
    fn grant_from_recovery_door(approver: &Path, recovery: &KeyId) -> SignedGrant {
        let mut config = FederationConfig::test_fixture("private", vec![]);
        config.recovery_key_id = Some(recovery.as_str().to_string());
        assert!(ensure_recovery_link(approver, &config, unix_now()).unwrap());
        stored_grant_to(approver, recovery)
    }

    #[tokio::test]
    async fn all_four_doors_produce_an_identical_grant_row() {
        let _env = test_hub::insecure_ws_env();
        let joiner = key(11);

        // Four clean directories holding the same key: each door starts from
        // the state the others started from, which is what "identical" has to
        // mean here.
        let via_hub = grant_from_hub_door(dir_with_seed(7).path(), &joiner).await;
        let via_qr = grant_from_qr_door(dir_with_seed(7).path(), &joiner).await;
        let via_offline = grant_from_offline_door(dir_with_seed(7).path(), &joiner);
        let via_recover = grant_from_recovery_door(dir_with_seed(7).path(), &joiner);

        // Verified with no hub in the picture: what each door produced has to
        // stand on its own bytes, or Door 3 means nothing.
        let hub = verify_grant(&via_hub).unwrap();
        for g in [&via_qr, &via_offline, &via_recover] {
            let st = verify_grant(g).unwrap();
            assert_eq!(st.kind, hub.kind);
            assert_eq!(st.from, hub.from);
            assert_eq!(st.to, hub.to);
            assert_eq!(st.scope, hub.scope);
            assert!(st.scope.is_none(), "a device link is unscoped — full authority");
            assert_eq!(st.kind, GrantKind::Link);
            assert_eq!(
                st.expires_at - st.issued_at,
                GrantKind::Link.default_ttl_secs(),
                "every grant expires, and a link's term is not the door's business"
            );
        }
        assert_eq!(hub.from, key(7));
        assert_eq!(hub.to, joiner);
    }

    #[test]
    fn the_offline_door_needs_no_hub() {
        let dir_new = fresh_dir();
        let dir_old = seeded_dir();
        let request = request_offline(dir_new.path()).unwrap();
        let grant = approve_offline(dir_old.path(), &request, &mut Yes::default()).unwrap();
        accept_offline(dir_new.path(), &grant).unwrap();
        assert!(
            has_active_link(dir_new.path()).unwrap(),
            "linking must not require the hub — it is a convenience, not an authority"
        );
    }

    #[test]
    fn the_pairing_code_commits_to_the_joining_key() {
        let a = PendingLink::for_key(key(1));
        let b = PendingLink::for_key(key(2));
        assert_ne!(
            a.fingerprint, b.fingerprint,
            "the fingerprint is what a hub cannot forge during pairing"
        );
        assert_ne!(a.code, b.code);
        assert_eq!(parse_pairing_code(&a.code).unwrap(), key(1));
        assert_eq!(parse_pairing_code(&b.code).unwrap(), key(2));
    }

    /// R-D. A pairing code carries a bare public key and no signature, and
    /// roughly half of all 32-byte strings are valid curve points — so a
    /// single mistyped character really can name a different, entirely
    /// legitimate key. The check characters are what turn that into a parse
    /// error, and the last assertion here is what proves they are earning
    /// their place rather than decorating the string.
    #[test]
    fn a_corrupted_pairing_code_fails_to_parse_rather_than_naming_a_different_key() {
        let original = key(1);
        let code = pairing_code(&original);
        assert_eq!(parse_pairing_code(&code).unwrap(), original, "the intact code parses");

        let body = original.as_str();
        let check = check_chars(&original);
        let mut a_typo_would_otherwise_have_named_a_different_key = false;
        for position in 1..body.len() {
            let mut chars: Vec<char> = body.chars().collect();
            // Base58 excludes 0, I, O and l; '2' and '3' are both in the
            // alphabet, so this substitution always produces a well-formed
            // base58 string rather than an obviously invalid one.
            chars[position] = if chars[position] == '2' { '3' } else { '2' };
            let mistyped: String = chars.into_iter().collect();
            if mistyped == body {
                continue;
            }
            if let Ok(other) = KeyId::parse(&mistyped) {
                if other != original {
                    a_typo_would_otherwise_have_named_a_different_key = true;
                }
            }
            let corrupted = format!("{PAIRING_TAG}.{mistyped}.{check}");
            assert!(
                parse_pairing_code(&corrupted).is_err(),
                "a one-character typo was accepted: {corrupted}"
            );
        }
        assert!(
            a_typo_would_otherwise_have_named_a_different_key,
            "without the check characters at least one of those typos names a valid \
             but different key — if this ever stops holding, the check has stopped \
             being the thing that catches it"
        );
    }

    #[test]
    fn a_pairing_code_from_somewhere_else_is_refused() {
        let original = key(1);
        assert!(parse_pairing_code(&format!("nope.{}.{}", original.as_str(), check_chars(&original))).is_err());
        assert!(parse_pairing_code(original.as_str()).is_err(), "a bare key_id is not a code");
        assert!(parse_pairing_code(&format!("{PAIRING_TAG}.{}", original.as_str())).is_err());
        assert!(parse_pairing_code(&grant_blob(&SignedGrant {
            statement: b"x".to_vec(),
            signature: b"y".to_vec()
        }))
        .is_err());
    }

    /// R-D, the other half: a door that shows one key's words and signs
    /// another's is the whole attack, and only comparing what the human saw
    /// against what was actually signed can catch it.
    #[test]
    fn the_fingerprint_shown_is_the_fingerprint_of_the_key_actually_signed_for() {
        let approver = seeded_dir();
        let joiner = fresh_dir();
        let mut confirm = Yes::default();
        let blob = approve_offline(
            approver.path(),
            &request_offline(joiner.path()).unwrap(),
            &mut confirm,
        )
        .unwrap();

        let st = verify_grant(&parse_grant_blob(&blob).unwrap()).unwrap();
        let (subject, shown) = confirm.shown.last().expect("the approver was shown nothing");
        assert_eq!(subject, "new machine");
        assert_eq!(shown, &words::fingerprint(&st.to));
        assert_ne!(
            shown,
            &words::fingerprint(&st.from),
            "showing the approver its own words would confirm nothing at all"
        );
    }

    #[test]
    fn approval_is_refused_when_the_fingerprint_is_not_confirmed() {
        let approver = seeded_dir();
        let joiner = key(11);

        let err = approve_offline(approver.path(), &pairing_code(&joiner), &mut No)
            .unwrap_err()
            .to_string();
        assert!(err.contains("fingerprint"), "{err}");
        assert!(
            load_grants(approver.path()).unwrap().is_empty(),
            "a declined confirmation must leave nothing signed"
        );

        // The accepting side of the same boundary: an implementation that
        // refuses everything would satisfy the assertion above on its own.
        approve_offline(approver.path(), &pairing_code(&joiner), &mut Yes::default()).unwrap();
        assert_eq!(load_grants(approver.path()).unwrap().len(), 1);
    }

    #[test]
    fn a_link_grant_is_signed_by_the_approver_not_the_joiner() {
        let approver = seeded_dir();
        let g = grant_from_offline_door(approver.path(), &key(11));
        assert!(verify_grant(&g).is_ok());
        assert_eq!(
            verify_grant(&g).unwrap().from,
            key_of(approver.path()),
            "only an established key can admit a new machine"
        );
    }

    /// Restricting approval to the first key recreates the single point of
    /// failure the design exists to remove: lose that machine and you can
    /// never add another. Run through the real doors rather than asking a
    /// predicate, so nothing here can agree with the code by construction.
    #[test]
    fn a_linked_key_may_approve_a_further_link() {
        let first = seeded_dir();
        let second = fresh_dir();
        let third = fresh_dir();

        let grant =
            approve_offline(first.path(), &request_offline(second.path()).unwrap(), &mut Yes::default())
                .unwrap();
        accept_offline(second.path(), &grant).unwrap();

        let onward = approve_offline(
            second.path(),
            &request_offline(third.path()).unwrap(),
            &mut Yes::default(),
        )
        .unwrap();
        accept_offline(third.path(), &onward).unwrap();

        let st = verify_grant(&parse_grant_blob(&onward).unwrap()).unwrap();
        assert_eq!(st.from, key_of(second.path()));
        assert_eq!(st.to, key_of(third.path()));
        assert!(has_active_link(third.path()).unwrap());
    }

    // -- a link is two grants ---------------------------------------------

    #[test]
    fn a_machine_holding_only_the_inbound_half_has_not_completed_the_link() {
        let approver = seeded_dir();
        let joiner = fresh_dir();
        let inbound =
            approve_offline(approver.path(), &request_offline(joiner.path()).unwrap(), &mut Yes::default())
                .unwrap();

        // The inbound half alone, stored without the answering step.
        remember(joiner.path(), &parse_grant_blob(&inbound).unwrap(), false).unwrap();
        assert!(has_active_link(joiner.path()).unwrap(), "it has been admitted");
        assert!(
            !is_mutual(joiner.path(), &key_of(approver.path())).unwrap(),
            "and has not yet said anything itself — a one-sided link that reads as \
             complete is the failure here"
        );

        assert!(ensure_link_to(joiner.path(), &key_of(approver.path()), unix_now()).unwrap());
        assert!(is_mutual(joiner.path(), &key_of(approver.path())).unwrap());
    }

    #[test]
    fn the_offline_door_answers_the_inbound_half_with_a_grant_of_its_own() {
        let approver = seeded_dir();
        let joiner = fresh_dir();
        let blob =
            approve_offline(approver.path(), &request_offline(joiner.path()).unwrap(), &mut Yes::default())
                .unwrap();
        accept_offline(joiner.path(), &blob).unwrap();

        let reciprocal = stored_grant_to(joiner.path(), &key_of(approver.path()));
        let st = verify_grant(&reciprocal).unwrap();
        assert_eq!(st.from, key_of(joiner.path()), "each key signs only its own sentence");
        assert_eq!(st.to, key_of(approver.path()));
        assert_eq!(st.kind, GrantKind::Link);
        assert!(is_mutual(joiner.path(), &key_of(approver.path())).unwrap());
    }

    #[tokio::test]
    async fn the_hub_door_answers_the_inbound_half_on_the_joiners_next_connection() {
        let _env = test_hub::insecure_ws_env();
        let approver = seeded_dir();
        let joiner = fresh_dir();
        seed_store::load_or_create(joiner.path()).unwrap();

        // The approver types the code and lodges A->B.
        let (hub_a, lodged_by_approver) = test_hub::spawn_grant_hub(vec![], vec![]).await;
        write_hub_config(approver.path(), &hub_a.ws_url(), None);
        approve(
            approver.path(),
            &request_offline(joiner.path()).unwrap(),
            &mut Yes::default(),
        )
        .await
        .unwrap();
        let a_to_b = lodged_by_approver.lock().unwrap().clone();
        assert_eq!(a_to_b.len(), 1);

        // The joiner connects and finds it waiting, exactly as the hub serves
        // every active grant to a key.
        let (hub_b, lodged_by_joiner) = test_hub::spawn_grant_hub(a_to_b.clone(), vec![]).await;
        write_hub_config(joiner.path(), &hub_b.ws_url(), None);
        connect_and_reconcile(joiner.path()).await.unwrap();

        let sent = lodged_by_joiner.lock().unwrap().clone();
        assert_eq!(sent.len(), 1, "the joiner owed exactly one grant: its own half");
        let st = verify_grant(&wire_to_signed(&sent[0])).unwrap();
        assert_eq!(st.from, key_of(joiner.path()), "B signs B->A; nobody signs for anybody");
        assert_eq!(st.to, key_of(approver.path()));
        assert_eq!(st.kind, GrantKind::Link);
        assert!(is_mutual(joiner.path(), &key_of(approver.path())).unwrap());
    }

    #[tokio::test]
    async fn a_second_connection_lodges_nothing_it_has_already_lodged() {
        let _env = test_hub::insecure_ws_env();
        let approver = seeded_dir();
        let joiner = fresh_dir();
        let a_to_b = {
            let blob = approve_offline(
                approver.path(),
                &request_offline(joiner.path()).unwrap(),
                &mut Yes::default(),
            )
            .unwrap();
            let g = parse_grant_blob(&blob).unwrap();
            vec![GrantWire {
                statement_b64: B64.encode(&g.statement),
                signature_b64: B64.encode(&g.signature),
                state: "active".into(),
            }]
        };

        let (hub_one, first) = test_hub::spawn_grant_hub(a_to_b.clone(), vec![]).await;
        write_hub_config(joiner.path(), &hub_one.ws_url(), None);
        connect_and_reconcile(joiner.path()).await.unwrap();
        assert_eq!(first.lock().unwrap().len(), 1);

        let (hub_two, second) = test_hub::spawn_grant_hub(a_to_b, vec![]).await;
        write_hub_config(joiner.path(), &hub_two.ws_url(), None);
        connect_and_reconcile(joiner.path()).await.unwrap();
        assert!(
            second.lock().unwrap().is_empty(),
            "a grant the hub has acknowledged is not owed again, and re-signing one \
             would put a second row on the hub for the same relationship"
        );
    }

    // -- what `reconcile` refuses from the hub -----------------------------

    /// A `GrantWire` naming `from -> to` as a `link`, signed however the
    /// caller likes. The hostile shapes below need a statement that says all
    /// the right things and a signature that does not stand behind it.
    fn link_wire(sk: &SigningKey, from: &KeyId, to: &KeyId, signature: Vec<u8>, state: &str) -> GrantWire {
        let now = unix_now();
        let st = GrantStatement {
            v: 5,
            kind: GrantKind::Link,
            from: from.clone(),
            to: to.clone(),
            scope: None,
            issued_at: now - 1,
            expires_at: now + 86_400,
            nonce: b64(&random_nonce()),
        };
        let statement = canonical_bytes(&st);
        let signature = if signature.is_empty() {
            sk.sign(&statement).to_bytes().to_vec()
        } else {
            signature
        };
        GrantWire {
            statement_b64: B64.encode(&statement),
            signature_b64: B64.encode(&signature),
            state: state.to_string(),
        }
    }

    /// The door an attacker can actually reach.
    ///
    /// `SyncReady.grants` is whatever the hub chose to send. If this client
    /// answers an inbound `link` without checking the signature, a hostile hub
    /// forges one and gets back a genuine, correctly signed, **full-authority**
    /// grant from this machine's own key — and every other machine in the
    /// person's set will verify that reciprocal happily, because it is real.
    ///
    /// Two shapes, because they fail for different reasons: a signature that is
    /// not a signature, and a real signature made by a key other than the one
    /// the statement names as issuer. Only the second distinguishes "verifies
    /// the signature" from "checks that some signature-shaped bytes arrived" —
    /// a hostile hub can always sign something.
    ///
    /// The accepting side of this boundary is
    /// `the_hub_door_answers_the_inbound_half_on_the_joiners_next_connection`:
    /// a properly signed inbound link IS answered, so this is not satisfied by
    /// an implementation that answers nothing.
    #[tokio::test]
    async fn a_forged_inbound_link_gets_no_reciprocal() {
        let _env = test_hub::insecure_ws_env();
        let machine = seeded_dir();
        let me = key_of(machine.path());
        let impostor_sk = SigningKey::from_bytes(&[41u8; 32]);
        let impostor = KeyId::from_pubkey(&impostor_sk.verifying_key());
        let somebody_else = SigningKey::from_bytes(&[43u8; 32]);

        let unsigned = link_wire(&impostor_sk, &impostor, &me, vec![0u8; 64], "active");
        let signed_by_the_wrong_key = {
            let bytes = B64.decode(
                link_wire(&impostor_sk, &impostor, &me, vec![], "active").statement_b64,
            )
            .unwrap();
            GrantWire {
                statement_b64: B64.encode(&bytes),
                signature_b64: B64.encode(somebody_else.sign(&bytes).to_bytes()),
                state: "active".into(),
            }
        };

        let (hub, lodged) =
            test_hub::spawn_grant_hub(vec![unsigned, signed_by_the_wrong_key], vec![]).await;
        write_hub_config(machine.path(), &hub.ws_url(), None);
        connect_and_reconcile(machine.path()).await.unwrap();

        assert!(
            lodged.lock().unwrap().is_empty(),
            "this machine signed a full-authority link in answer to bytes nobody stands \
             behind: {:?}",
            lodged.lock().unwrap()
        );
        assert!(
            load_grants(machine.path()).unwrap().is_empty(),
            "and it must not be stored either — a forged grant in the local store is one \
             `ll link list` reports as real"
        );
    }

    /// A grant the hub does not call `active` is not one to act on. Revocation
    /// is the issuer withdrawing its own statement, and the withdrawn statement
    /// keeps verifying forever — the signature is still good, which is exactly
    /// why the state has to be read. Answering one would bring a revoked link
    /// back to life from the side that did not revoke it.
    #[tokio::test]
    async fn a_grant_the_hub_does_not_call_active_gets_no_reciprocal() {
        let _env = test_hub::insecure_ws_env();
        let machine = seeded_dir();
        let me = key_of(machine.path());
        let issuer = SigningKey::from_bytes(&[41u8; 32]);
        let issuer_id = KeyId::from_pubkey(&issuer.verifying_key());
        let revoked = link_wire(&issuer, &issuer_id, &me, vec![], "revoked");

        let (hub, lodged) = test_hub::spawn_grant_hub(vec![revoked], vec![]).await;
        write_hub_config(machine.path(), &hub.ws_url(), None);
        connect_and_reconcile(machine.path()).await.unwrap();

        assert!(lodged.lock().unwrap().is_empty(), "{:?}", lodged.lock().unwrap());
        assert!(load_grants(machine.path()).unwrap().is_empty());
    }

    /// `assoc` exists precisely to join a person's work and personal
    /// identities WITHOUT transferring authority. Answering one with a `link`
    /// would hand an employer-governed key the ability to act as a personal
    /// one — the single thing the two-key model exists to prevent — and it
    /// would do it from this side, unasked.
    #[tokio::test]
    async fn an_inbound_grant_that_is_not_a_link_is_never_answered_with_one() {
        let _env = test_hub::insecure_ws_env();
        let machine = seeded_dir();
        let me = key_of(machine.path());
        let issuer = SigningKey::from_bytes(&[41u8; 32]);
        let issuer_id = KeyId::from_pubkey(&issuer.verifying_key());
        let now = unix_now();

        let mut served = Vec::new();
        for kind in [GrantKind::Assoc, GrantKind::Follow, GrantKind::Peer] {
            let st = GrantStatement {
                v: 5,
                kind,
                from: issuer_id.clone(),
                to: me.clone(),
                scope: None,
                issued_at: now - 1,
                expires_at: now + 86_400,
                nonce: b64(&random_nonce()),
            };
            let bytes = canonical_bytes(&st);
            served.push(GrantWire {
                statement_b64: B64.encode(&bytes),
                signature_b64: B64.encode(issuer.sign(&bytes).to_bytes()),
                state: "active".into(),
            });
        }

        let (hub, lodged) = test_hub::spawn_grant_hub(served, vec![]).await;
        write_hub_config(machine.path(), &hub.ws_url(), None);
        connect_and_reconcile(machine.path()).await.unwrap();

        assert!(
            lodged.lock().unwrap().is_empty(),
            "an assoc, a follow or a peer edge was answered with a link: {:?}",
            lodged.lock().unwrap()
        );
    }

    /// A lapsed link is not renewed from this side.
    ///
    /// The hub filters expired rows out of `SyncReady`, so this needs a hub
    /// that does not — which is the point: `state` is the hub's word and the
    /// expiry is the issuer's, carried inside bytes the issuer signed. Without
    /// this check a link that lapsed on disuse comes back the moment the other
    /// machine connects, because this one answers it with a fresh year.
    #[tokio::test]
    async fn a_lapsed_inbound_link_gets_no_reciprocal() {
        let _env = test_hub::insecure_ws_env();
        let machine = seeded_dir();
        let me = key_of(machine.path());
        let issuer = SigningKey::from_bytes(&[41u8; 32]);
        let issuer_id = KeyId::from_pubkey(&issuer.verifying_key());
        let st = GrantStatement {
            v: 5,
            kind: GrantKind::Link,
            from: issuer_id,
            to: me,
            scope: None,
            issued_at: 1_000_000,
            expires_at: 1_000_001,
            nonce: b64(&random_nonce()),
        };
        let bytes = canonical_bytes(&st);
        let lapsed = GrantWire {
            statement_b64: B64.encode(&bytes),
            signature_b64: B64.encode(issuer.sign(&bytes).to_bytes()),
            state: "active".into(),
        };

        let (hub, lodged) = test_hub::spawn_grant_hub(vec![lapsed], vec![]).await;
        write_hub_config(machine.path(), &hub.ws_url(), None);
        connect_and_reconcile(machine.path()).await.unwrap();

        assert!(
            lodged.lock().unwrap().is_empty(),
            "a link that lapsed on disuse was answered with a fresh year: {:?}",
            lodged.lock().unwrap()
        );
        assert!(load_grants(machine.path()).unwrap().is_empty());
    }

    /// `SyncReady.grants` carries what the hub holds, and a hub is free to put
    /// anything in it. A grant between two keys that are not this one is not
    /// this machine's business to store or to answer.
    #[tokio::test]
    async fn a_link_between_two_other_keys_is_neither_stored_nor_answered() {
        let _env = test_hub::insecure_ws_env();
        let machine = seeded_dir();
        let a_sk = SigningKey::from_bytes(&[41u8; 32]);
        let a = KeyId::from_pubkey(&a_sk.verifying_key());
        let b = key(43);
        let theirs = link_wire(&a_sk, &a, &b, vec![], "active");

        let (hub, lodged) = test_hub::spawn_grant_hub(vec![theirs], vec![]).await;
        write_hub_config(machine.path(), &hub.ws_url(), None);
        connect_and_reconcile(machine.path()).await.unwrap();

        assert!(lodged.lock().unwrap().is_empty(), "{:?}", lodged.lock().unwrap());
        assert!(
            load_grants(machine.path()).unwrap().is_empty(),
            "somebody else's link is not this machine's record to keep"
        );
    }

    // -- the recovery door -------------------------------------------------

    #[tokio::test]
    async fn a_cycle_gives_the_recovery_key_the_link_that_makes_the_words_usable() {
        let _env = test_hub::insecure_ws_env();
        let machine = seeded_dir();
        let recovery = key(23);

        let (hub, lodged) = test_hub::spawn_grant_hub(vec![], vec![]).await;
        write_hub_config(machine.path(), &hub.ws_url(), Some(&recovery));
        connect_and_reconcile(machine.path()).await.unwrap();

        let sent = lodged.lock().unwrap().clone();
        assert_eq!(sent.len(), 1, "the recovery key had no grant and now has one");
        let st = verify_grant(&wire_to_signed(&sent[0])).unwrap();
        assert_eq!(st.to, recovery);
        assert_eq!(st.from, key_of(machine.path()));
        assert_eq!(st.kind, GrantKind::Link);
    }

    /// The store is this key's only memory of what it signed, and `SyncReady`
    /// carries both directions — so a machine that lost the file learns its
    /// outbound half back from the hub rather than signing a second one.
    #[tokio::test]
    async fn a_machine_that_lost_its_store_does_not_re_issue_a_grant_the_hub_already_holds() {
        let _env = test_hub::insecure_ws_env();
        let machine = seeded_dir();
        let recovery = key(23);
        let existing =
            issue_link_grant(&local_signing_key(machine.path()).unwrap(), &recovery, unix_now() - 10)
                .unwrap();
        let wire = GrantWire {
            statement_b64: B64.encode(&existing.statement),
            signature_b64: B64.encode(&existing.signature),
            state: "active".into(),
        };
        assert!(load_grants(machine.path()).unwrap().is_empty(), "precondition: the file is gone");

        let (hub, lodged) = test_hub::spawn_grant_hub(vec![wire], vec![]).await;
        write_hub_config(machine.path(), &hub.ws_url(), Some(&recovery));
        connect_and_reconcile(machine.path()).await.unwrap();

        assert!(
            lodged.lock().unwrap().is_empty(),
            "the hub already holds this grant; signing a second would put a duplicate \
             row on it for the same relationship"
        );
        assert_eq!(load_grants(machine.path()).unwrap().len(), 1, "and the store learned it back");
    }

    #[test]
    fn a_config_with_no_recovery_key_issues_nothing() {
        let machine = seeded_dir();
        let config = FederationConfig::test_fixture("private", vec![]);
        assert!(!ensure_recovery_link(machine.path(), &config, unix_now()).unwrap());
        assert!(load_grants(machine.path()).unwrap().is_empty());
    }

    // -- what a door refuses ----------------------------------------------

    #[test]
    fn a_grant_addressed_to_another_machine_is_not_accepted_here() {
        let approver = seeded_dir();
        let intended = fresh_dir();
        let bystander = dir_with_seed(31);
        let blob =
            approve_offline(approver.path(), &request_offline(intended.path()).unwrap(), &mut Yes::default())
                .unwrap();

        let err = accept_offline(bystander.path(), &blob).unwrap_err().to_string();
        assert!(err.contains("admits"), "{err}");
        assert!(load_grants(bystander.path()).unwrap().is_empty());
        assert!(!has_active_link(bystander.path()).unwrap());

        // The machine it was actually addressed to takes it.
        accept_offline(intended.path(), &blob).unwrap();
        assert!(has_active_link(intended.path()).unwrap());
    }

    #[test]
    fn a_tampered_grant_blob_is_not_accepted() {
        let approver = seeded_dir();
        let joiner = fresh_dir();
        let blob =
            approve_offline(approver.path(), &request_offline(joiner.path()).unwrap(), &mut Yes::default())
                .unwrap();

        // Flip a byte inside the statement, leaving the blob well-formed and
        // the signature untouched: only the signature check can catch this.
        let good = parse_grant_blob(&blob).unwrap();
        let mut statement = good.statement.clone();
        let pos = statement.windows(6).position(|w| w == b"nonce\"").unwrap() + 8;
        statement[pos] ^= 0x01;
        let tampered = grant_blob(&SignedGrant { statement, signature: good.signature.clone() });

        assert!(accept_offline(joiner.path(), &tampered).is_err());
        assert!(load_grants(joiner.path()).unwrap().is_empty());
        accept_offline(joiner.path(), &blob).unwrap();
    }

    #[test]
    fn a_machine_with_no_identity_cannot_admit_anything() {
        let empty = fresh_dir();
        let err = approve_offline(empty.path(), &pairing_code(&key(11)), &mut Yes::default())
            .unwrap_err()
            .to_string();
        assert!(err.contains("no identity"), "{err}");
    }

    // -- lodging -----------------------------------------------------------

    #[tokio::test]
    async fn a_grant_the_hub_refuses_stays_owed() {
        let _env = test_hub::insecure_ws_env();
        let approver = seeded_dir();
        approve_offline(approver.path(), &pairing_code(&key(11)), &mut Yes::default()).unwrap();

        let (hub, _lodged) =
            test_hub::spawn_grant_hub(vec![], vec![GrantAnswer::Reject("grant rejected: nope")]).await;
        write_hub_config(approver.path(), &hub.ws_url(), None);

        let err = connect_and_reconcile(approver.path()).await.unwrap_err().to_string();
        assert!(err.contains("hub refused"), "{err}");
        assert!(
            load_grants(approver.path()).unwrap().iter().all(|g| !g.lodged),
            "a refused grant must stay owed — the recoverable failure is the one \
             where the client remembers more than the hub does"
        );
    }

    #[tokio::test]
    async fn an_ack_naming_a_different_grant_is_not_an_ack() {
        let _env = test_hub::insecure_ws_env();
        let approver = seeded_dir();
        approve_offline(approver.path(), &pairing_code(&key(11)), &mut Yes::default()).unwrap();

        let (hub, _lodged) = test_hub::spawn_grant_hub(vec![], vec![GrantAnswer::AckWrongId]).await;
        write_hub_config(approver.path(), &hub.ws_url(), None);

        let err = connect_and_reconcile(approver.path()).await.unwrap_err().to_string();
        assert!(err.contains("stored something other than what was sent"), "{err}");
        assert!(load_grants(approver.path()).unwrap().iter().all(|g| !g.lodged));
    }

    // -- the store ---------------------------------------------------------

    #[test]
    fn an_unreadable_grant_store_is_an_error_not_an_empty_one() {
        let dir = seeded_dir();
        std::fs::write(grants_path(dir.path()), b"{ not json").unwrap();
        assert!(
            load_grants(dir.path()).is_err(),
            "a store this machine cannot read is not a machine with no links"
        );
    }

    #[test]
    fn a_missing_grant_store_is_simply_no_grants() {
        let dir = seeded_dir();
        assert!(load_grants(dir.path()).unwrap().is_empty());
        assert!(!has_active_link(dir.path()).unwrap());
    }

    #[test]
    fn list_reports_both_directions_as_one_mutual_row() {
        let approver = seeded_dir();
        let joiner = fresh_dir();
        let blob =
            approve_offline(approver.path(), &request_offline(joiner.path()).unwrap(), &mut Yes::default())
                .unwrap();
        accept_offline(joiner.path(), &blob).unwrap();

        let rows = list(joiner.path()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].other, key_of(approver.path()).as_str());
        assert_eq!(rows[0].direction, "mutual");
        assert_eq!(rows[0].fingerprint, words::fingerprint(&key_of(approver.path())));

        let approver_rows = list(approver.path()).unwrap();
        assert_eq!(approver_rows.len(), 1);
        assert_eq!(approver_rows[0].direction, "outbound", "it has not heard back yet");
    }

    #[test]
    fn a_lapsed_link_is_not_an_active_one() {
        let dir = seeded_dir();
        let sk = local_signing_key(dir.path()).unwrap();
        let long_ago = 1_000_000i64;
        let expired = issue_link_grant(&sk, &key(11), long_ago).unwrap();
        remember(dir.path(), &expired, false).unwrap();
        assert!(active_grants(dir.path(), unix_now()).unwrap().is_empty());

        let current = issue_link_grant(&sk, &key(11), unix_now()).unwrap();
        remember(dir.path(), &current, false).unwrap();
        assert_eq!(active_grants(dir.path(), unix_now()).unwrap().len(), 1);
    }

    #[test]
    fn a_machine_cannot_link_to_itself() {
        let dir = seeded_dir();
        let me = key_of(dir.path());
        assert!(issue_link_grant(&local_signing_key(dir.path()).unwrap(), &me, unix_now()).is_err());
        assert!(!ensure_link_to(dir.path(), &me, unix_now()).unwrap());
    }

    // -- Door 1's joining half --------------------------------------------

    #[tokio::test]
    async fn request_pins_the_hub_and_writes_a_config_without_connecting() {
        let _env = test_hub::insecure_ws_env();
        let dir = fresh_dir();
        let hub = test_hub::spawn_well_known_only(&test_hub::hub_key_id_str(), PROTOCOL_VERSION).await;
        let mut confirm = Yes::default();

        let pending = request(
            dir.path(),
            &hub.ws_url(),
            &PathBuf::from("/tmp/second-machine"),
            &mut confirm,
        )
        .await
        .unwrap();

        let written = config::load_config(dir.path()).unwrap();
        assert_eq!(written.hub.key_id.as_deref(), Some(test_hub::hub_key_id_str().as_str()));
        assert!(written.vault_id.is_some());
        assert!(
            written.recovery_key_id.is_none(),
            "the recovery key belongs to the person and this machine did not mint one"
        );
        assert_eq!(pending.joining_key, key_of(dir.path()));
        assert_eq!(pending.code, pairing_code(&pending.joining_key));
        assert_eq!(pending.fingerprint, words::fingerprint(&pending.joining_key));
        let (subject, shown) = confirm.shown.first().unwrap();
        assert_eq!(subject, "hub identity");
        assert_eq!(shown, &words::fingerprint(&KeyId::parse(&test_hub::hub_key_id_str()).unwrap()));
    }

    #[tokio::test]
    async fn request_refuses_a_hub_whose_fingerprint_is_not_confirmed() {
        let _env = test_hub::insecure_ws_env();
        let dir = fresh_dir();
        let hub = test_hub::spawn_well_known_only(&test_hub::hub_key_id_str(), PROTOCOL_VERSION).await;

        let err = request(dir.path(), &hub.ws_url(), &PathBuf::from("/tmp/x"), &mut No)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("fingerprint"), "{err}");
        assert!(!config::config_path(dir.path()).exists());
    }
}
