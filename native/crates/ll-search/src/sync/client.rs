use std::path::Path;
use std::time::Duration;
use anyhow::Context;
use ed25519_dalek::SigningKey;
use futures_util::{SinkExt, StreamExt};
use rusqlite::Connection;
use serde::Serialize;
use sha2::{Sha256, Digest};
use tokio_tungstenite::tungstenite::Message;

use super::auth;
use super::config::{export_db_path, last_export_mtime_path, seed_path, FederationConfig};
use super::error::SyncError;
use super::export::{export_index, ExportResult};
use super::fetch::{fetch_all, Fetched};
use super::grants;
use super::handshake::SyncReadyPayload;
use super::key_id::KeyId;
use super::protocol::{ENVELOPE_HEADER_LEN, HUB_INBOUND_CAP};
use super::protocol_v5::{ClientMsg, HubMsg, VaultState};
use super::state::{self, HubHolds, SyncState};

const RECV_TIMEOUT: Duration = Duration::from_secs(30);
const SEND_TIMEOUT: Duration = Duration::from_secs(60);

/// Read `var` as a millisecond count, once. `std::env::set_var` is not
/// thread-safe against a concurrent `std::env::var`, and a test binary is one
/// process running its tests in parallel threads — so these two were read on
/// every frame the client sent or received while some other test in the same
/// binary was writing the environment. That race is why a mutation in one file
/// could redden a test in another: the coupling was the process environment,
/// not the code.
///
/// Reading once puts every read before the first connection in the binaries
/// that set these (`sync_recv_timeout.rs`, `sync_soak.rs`, both of which set
/// the value at the top of their single test), which is the whole window the
/// override needs.
fn env_millis(var: &str, fallback: Duration) -> Duration {
    std::env::var(var)
        .ok()
        .and_then(|s| s.parse().ok())
        .map(Duration::from_millis)
        .unwrap_or(fallback)
}

/// Test-only override for `RECV_TIMEOUT` via `LL_SYNC_RECV_TIMEOUT_MS` env var.
/// Production callers ignore this; it exists so integration tests can shorten
/// the silent-hub timeout from 30s to ~1s without changing source code.
fn recv_timeout() -> Duration {
    static RESOLVED: std::sync::OnceLock<Duration> = std::sync::OnceLock::new();
    *RESOLVED.get_or_init(|| env_millis("LL_SYNC_RECV_TIMEOUT_MS", RECV_TIMEOUT))
}

fn send_timeout() -> Duration {
    static RESOLVED: std::sync::OnceLock<Duration> = std::sync::OnceLock::new();
    *RESOLVED.get_or_init(|| env_millis("LL_SYNC_SEND_TIMEOUT_MS", SEND_TIMEOUT))
}

pub(super) type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// Tailscale's CGNAT range (100.64.0.0/10): first octet 100, second octet
/// in 64..=127. Tailnet traffic is already WireGuard-encrypted end-to-end,
/// so requiring TLS on top buys nothing.
fn is_tailscale_cgnat_ip(host: &str) -> bool {
    host.parse::<std::net::Ipv4Addr>()
        .map(|ip| {
            let [a, b, ..] = ip.octets();
            a == 100 && (64..=127).contains(&b)
        })
        .unwrap_or(false)
}

/// Enforce wss:// for hub connections. Cleartext `ws://` (and any other
/// scheme) is rejected so the vault index never streams unencrypted, EXCEPT
/// for loopback hosts (127.0.0.1 / ::1 / localhost) and Tailscale tailnet
/// hosts (100.64.0.0/10 CGNAT range, or `.ts.net` MagicDNS names), where
/// ws:// is allowed since those transports are already encrypted.
pub(super) fn check_hub_scheme(endpoint: &str) -> anyhow::Result<()> {
    let rest = endpoint.trim();
    if let Some(after) = rest.strip_prefix("wss://") {
        let _ = after;
        return Ok(());
    }
    if let Some(after) = rest.strip_prefix("ws://") {
        let authority = after
            .split(|c| c == '/' || c == '?' || c == '#')
            .next()
            .unwrap_or("");
        let host = if let Some(rest) = authority.strip_prefix('[') {
            rest.split(']').next().unwrap_or("")
        } else {
            authority.split(':').next().unwrap_or("")
        };
        if host == "127.0.0.1" || host == "::1" || host == "localhost" {
            return Ok(());
        }
        if is_tailscale_cgnat_ip(host) || host.ends_with(".ts.net") {
            return Ok(());
        }
        anyhow::bail!(
            "refusing cleartext ws:// connection to non-loopback hub {endpoint:?}; \
             federation requires wss:// (or a Tailscale tailnet host)"
        );
    }
    let scheme = rest.split("://").next().unwrap_or(rest);
    anyhow::bail!(
        "unsupported hub scheme {scheme:?} in {endpoint:?}; federation requires wss://"
    )
}

#[derive(Debug, Serialize)]
pub struct SyncResult {
    pub export: Option<ExportResult>,
    pub uploaded_notes: i64,
    pub skipped_upload: bool,
    /// The vaults this cycle read through a grant and wrote. A vault whose
    /// index the hub served unchanged is in `unchanged_fetches`, not here —
    /// nothing on disk moved, so nothing downstream needs to rerun.
    pub fetched: Vec<Fetched>,
    /// The vaults whose local copy was already the index the hub holds.
    pub unchanged_fetches: Vec<String>,
    /// The vaults it was entitled to read and could not. One failure does not
    /// abort the others, so this is how they stay visible.
    pub skipped_fetches: Vec<String>,
    /// Grants the hub answered and refused. They stay owed and the next cycle
    /// offers them again — but the hub's answer will be the same, so unlike a
    /// dropped connection this is worth saying out loud.
    pub refused_grants: Vec<String>,
}

/// Run one sync cycle and record what it did, whether it worked or not.
///
/// Every way the cycle can fail lives inside `run_cycle`, so a cycle that
/// dies before it ever reaches the hub still leaves a state file behind —
/// that is precisely the cycle nobody noticed for two months.
pub async fn sync_all_async(
    source_db: &Path,
    vault_path: &Path,
    config_dir: &Path,
    config: &FederationConfig,
) -> anyhow::Result<SyncResult> {
    // The last thing this cycle knew the hub to hold. `run_cycle` fills it in
    // as it learns, so a cycle that dies halfway records what it had learned
    // by then rather than nothing at all.
    let mut known_holds = None;
    let outcome = run_cycle(source_db, vault_path, config_dir, config, &mut known_holds).await;

    let now = unix_now();
    // `None` on the error path rather than 0: the read half runs last, so a
    // cycle that failed never reached it and "nothing was skipped" would be a
    // claim it is in no position to make.
    let (outcome_label, detail, last_success_at, skipped_fetches, refused_grants) = match &outcome {
        Ok(result) => (
            state::OUTCOME_OK,
            None,
            Some(now),
            Some(result.skipped_fetches.len()),
            Some(result.refused_grants.len()),
        ),
        Err(e) => (
            state::OUTCOME_ERROR,
            Some(e.to_string()),
            // A failure must not erase when this vault last synced: how long
            // the outage has been running is the whole question. Best-effort
            // by construction — `read_state` reports a corrupt file as
            // missing, so one corruption loses the answer permanently.
            state::read_state(config_dir)
                .ok()
                .flatten()
                .and_then(|prev| prev.last_success_at),
            None,
            None,
        ),
    };
    // Failing to record the cycle must never mask the cycle's own error.
    let _ = state::write_state(config_dir, &SyncState {
        last_attempt_at: now,
        last_success_at,
        outcome: outcome_label.to_string(),
        detail,
        hub_holds: known_holds,
        skipped_fetches,
        refused_grants,
    });

    outcome
}

pub(super) fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

async fn run_cycle(
    source_db: &Path,
    vault_path: &Path,
    config_dir: &Path,
    config: &FederationConfig,
    known_holds: &mut Option<HubHolds>,
) -> anyhow::Result<SyncResult> {
    let prepared = prepare_export(source_db, vault_path, config_dir, config).await?;

    // Pre-flight upload size check (R12). Frame overhead is 36 bytes.
    if prepared.bytes.len() + ENVELOPE_HEADER_LEN > HUB_INBOUND_CAP {
        return Err(SyncError::EnvelopeOversize { cap: HUB_INBOUND_CAP }.into());
    }

    let seed = auth::load_seed(&seed_path(config_dir))?;
    let peer_id = config.identity.display_name.clone();

    let (mut ws, ready) =
        connect_and_authenticate(config, &seed, &peer_id, &prepared.model_id, None).await?;

    let me = KeyId::from_pubkey(&seed.verifying_key());

    // Everything the hub served, folded into the store before anything acts
    // on it. `reconcile` decides what it owes against this file, and a
    // revocation can only ever be resolved against a grant that was kept —
    // a revoked grant is absent from `SyncReady.grants` and arrives as a
    // signed statement about an id, nothing more.
    grants::apply_grants(config_dir, &ready.grants)?;

    // And the deletions before any of the network half. Spec:334 is not
    // best-effort: a cycle that dies uploading must still have stopped
    // serving what it no longer holds a grant for.
    let swept: Vec<String> = grants::apply_revocations(config_dir, &ready.revocations, &me, unix_now())?
        .into_iter()
        .chain(grants::prune_expired(config_dir, &me, unix_now())?)
        .collect();
    for vault_id in &swept {
        eprintln!("Removed the cached index for {vault_id}: the grant behind it is gone");
    }

    // Before anything vault-shaped. A machine that was linked a minute ago
    // owes the other half of that link and may hold nothing else worth
    // uploading; settling the key graph first means an upload problem cannot
    // leave a person's second machine half-joined.
    let links =
        super::link::reconcile(&mut ws, config_dir, config, &ready.grants, unix_now()).await?;

    let (vault_id, this_vault) = this_vault_state(config, &ready.vault_state)?;
    // What the hub reported at the handshake. Everything after this point
    // can fail, and if it does this is the last thing we knew.
    *known_holds = Some(hub_holds(this_vault));

    // The same list the read half is about to fetch, written down so the
    // SEARCH path can filter on it — `readable_vaults` is called here and
    // again inside `fetch_all` rather than being computed twice in two
    // shapes, because a cache the reader serves and a cache the fetcher
    // writes must be the same set or the difference is somebody's notes.
    //
    // Here, before the upload, for the reason `apply_revocations` is: a cycle
    // that dies uploading must still have stopped serving what the hub no
    // longer lists. And stamped with `at`, because how old this answer is is
    // the only honest thing a long-offline machine can say about it.
    let listed_at = unix_now();
    state::write_readable_vaults(config_dir, &state::ReadableVaults {
        at: listed_at,
        vault_ids: super::fetch::readable_vaults(
            &ready.vault_state, &ready.grants, &me, vault_id, listed_at,
        ),
    })?;

    let uploaded = upload_index(&mut ws, config_dir, vault_id, this_vault, &prepared).await?;
    *known_holds = Some(uploaded.hub_holds);

    // The read half asks for exactly the vaults the hub named at the
    // handshake, less this one. Nothing here asks it to list anything, and
    // nothing here derives the list from a grant: a `link` is unscoped, so a
    // client that tried would read nothing on a machine that was just linked.
    let read =
        fetch_all(&mut ws, config_dir, &ready.vault_state, &ready.grants, &me, vault_id, unix_now())
            .await?;

    let _ = ws.close(None).await;
    eprintln!("Sync complete");

    Ok(SyncResult {
        export: prepared.result,
        uploaded_notes: uploaded.note_count,
        skipped_upload: uploaded.skipped,
        fetched: read.fetched,
        unchanged_fetches: read.unchanged,
        skipped_fetches: read.skipped,
        refused_grants: links.refused.into_iter().map(|r| r.grant_id).collect(),
    })
}

struct PreparedExport {
    bytes: Vec<u8>,
    hash: String,
    current_max_mtime: u64,
    note_count: i64,
    schema_version: String,
    model_id: String,
    result: Option<ExportResult>,
}

async fn prepare_export(
    source_db: &Path,
    vault_path: &Path,
    config_dir: &Path,
    config: &FederationConfig,
) -> anyhow::Result<PreparedExport> {
    let export_path = export_db_path(config_dir);
    std::fs::create_dir_all(config_dir.join("federation"))?;
    let mtime_path = last_export_mtime_path(config_dir);

    let last_mtime: u64 = std::fs::read_to_string(&mtime_path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    let vault_owned = vault_path.to_path_buf();
    let current_max_mtime = tokio::task::spawn_blocking(move || max_md_mtime(&vault_owned))
        .await
        .map_err(|e| anyhow::anyhow!("mtime scan task panicked: {e}"))?;
    let vault_changed = current_max_mtime > last_mtime;

    let need_export = vault_changed || !export_path.exists();
    let (bytes, result) = if need_export {
        eprintln!("Exporting local index...");
        let source_owned = source_db.to_path_buf();
        let vault_owned = vault_path.to_path_buf();
        let export_owned = export_path.clone();
        let config_owned = config.clone();
        let result = tokio::task::spawn_blocking(move || {
            export_index(&source_owned, &vault_owned, &export_owned, &config_owned)
        })
        .await
        .map_err(|e| anyhow::anyhow!("export task panicked: {e}"))??;
        eprintln!("Export complete: {} exported, {} skipped", result.exported, result.skipped);
        let export_owned = export_path.clone();
        let bytes = tokio::task::spawn_blocking(move || std::fs::read(&export_owned))
            .await
            .map_err(|e| anyhow::anyhow!("export read task panicked: {e}"))??;
        (bytes, Some(result))
    } else {
        eprintln!("No vault changes since last export");
        let export_owned = export_path.clone();
        let bytes = tokio::task::spawn_blocking(move || std::fs::read(&export_owned))
            .await
            .map_err(|e| anyhow::anyhow!("export read task panicked: {e}"))??;
        (bytes, None)
    };
    let hash = hex::encode(Sha256::digest(&bytes));

    // Read the upload metadata from the export we are about to send, never
    // from the source index or from `ExportResult`. When the export is reused
    // from disk, a re-index in between would make the source's `model_id`
    // describe different bytes than the ones on the wire.
    let export_owned = export_path.clone();
    let (note_count, schema_version, model_id) = tokio::task::spawn_blocking(
        move || -> anyhow::Result<(i64, String, String)> {
            let export = Connection::open_with_flags(
                &export_owned,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            let meta = |key: &str| -> anyhow::Result<String> {
                Ok(export.query_row(
                    "SELECT value FROM meta WHERE key = ?1",
                    [key],
                    |r| r.get::<_, String>(0),
                )?)
            };
            let note_count = meta("note_count")?
                .parse()
                .context("export meta note_count is not an integer")?;
            Ok((note_count, meta("schema_version")?, meta("model_id")?))
        },
    )
    .await
    .map_err(|e| anyhow::anyhow!("export meta lookup panicked: {e}"))??;

    Ok(PreparedExport {
        bytes,
        hash,
        current_max_mtime,
        note_count,
        schema_version,
        model_id,
        result,
    })
}

/// The TLS trust this client offers a hub.
///
/// Byte-for-byte the store `connect_async` builds for itself under the
/// `rustls-tls-webpki-roots` feature: an empty `RootCertStore` extended with
/// `webpki_roots::TLS_SERVER_ROOTS`, and `with_no_client_auth()`. Naming it
/// here rather than letting the default happen changes nothing a hub can
/// observe; it buys one thing, a `ClientConfig` this crate owns.
///
/// That is the only place an extra root can attach, and the attachment is a
/// `#[cfg(test)]` statement. `cargo build`, `cargo build --release`, and the
/// lib that this crate's own `tests/` binaries link are all compiled without
/// `cfg(test)`, so a shipped binary holds no instruction that could widen
/// this store — there is no environment variable, config field or file for an
/// attacker to reach, because there is no code to reach. The source-level
/// check `the_extra_root_exists_only_under_cfg_test` keeps it that way.
fn hub_tls_connector() -> tokio_tungstenite::Connector {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    #[cfg(test)]
    tests::extend_with_test_anchors(&mut roots);
    tokio_tungstenite::Connector::Rustls(std::sync::Arc::new(
        rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    ))
}

pub(super) async fn connect_and_authenticate(
    config: &FederationConfig,
    seed: &SigningKey,
    peer_id: &str,
    model_id: &str,
    invite: Option<&str>,
) -> anyhow::Result<(WsStream, SyncReadyPayload)> {
    let hub_url = &config.hub.endpoint;
    check_hub_scheme(hub_url)?;
    let connect_url = if hub_url.ends_with("/ws") {
        hub_url.clone()
    } else {
        format!("{}/ws", hub_url.trim_end_matches('/'))
    };
    eprintln!("Connecting to hub at {connect_url} as {peer_id} (model {model_id})...");
    let (mut ws, _response) = tokio_tungstenite::connect_async_tls_with_config(
        &connect_url,
        None,
        false,
        Some(hub_tls_connector()),
    )
    .await
    .context("failed to connect to hub")?;

    // Channel binding: the exporter ties a completed handshake to this exact
    // TLS session, so relaying it onto a different connection fails
    // signature verification. `LL_ALLOW_INSECURE_WS` is the local test
    // harness escape hatch only (`check_hub_scheme` already restricts
    // cleartext `ws://` to loopback/tailnet hosts).
    let exporter = match ws.get_ref() {
        tokio_tungstenite::MaybeTlsStream::Rustls(tls) => {
            let (_io, conn) = tls.get_ref();
            let mut out = [0u8; 32];
            conn.export_keying_material(&mut out, super::handshake::EXPORTER_LABEL, None)?;
            out
        }
        _ if std::env::var("LL_ALLOW_INSECURE_WS").is_ok() => [0u8; 32],
        _ => anyhow::bail!("hub connection is not TLS; refusing to authenticate"),
    };

    let vault_ids: Vec<String> = config.vault_id.clone().into_iter().collect();
    let ready = super::handshake::authenticate(&mut ws, seed, config, &vault_ids, &exporter, invite).await?;
    eprintln!("Authenticated (protocol v{})", ready.protocol_version);

    Ok((ws, ready))
}

#[derive(Debug, PartialEq, Eq)]
pub enum UploadDecision {
    Upload,
    Skip,
}

/// Decide whether to upload, using ONLY what the hub reports it holds.
///
/// v4 read `federation/last-export-hash` — a local file describing what this
/// client believed it had once uploaded. When the hub lost its index (or, as
/// happened, never had one because its credentials were absent), the client
/// kept reporting "no changes" forever and nothing ever re-uploaded.
///
/// `last-export-hash` is gone — nothing read it once the hub became the
/// authority, and a file in `federation/` that looks authoritative and is
/// read by nothing is how this bug got written in the first place. The
/// separate `last-export-mtime` decides whether to re-export; it never
/// decides whether to send.
pub fn upload_decision(export_hash: &str, state: Option<&VaultState>) -> UploadDecision {
    match state.and_then(|s| s.holds.as_ref()) {
        Some(held) if held.sha256 == export_hash => UploadDecision::Skip,
        _ => UploadDecision::Upload,
    }
}

/// The hub's report for the vault this config is joined to, resolved once.
///
/// The upload decision and `sync-state.json` describe the same entry; two
/// lookups is how they would come to describe different ones.
fn this_vault_state<'c, 'v>(
    config: &'c FederationConfig,
    vault_state: &'v [VaultState],
) -> anyhow::Result<(&'c str, Option<&'v VaultState>)> {
    let vault_id = config.vault_id.as_deref().ok_or_else(|| {
        anyhow::anyhow!("no vault_id in this federation config; run `ll join` in this vault")
    })?;
    Ok((vault_id, vault_state.iter().find(|v| v.vault_id == vault_id)))
}

/// What the upload half did, and what the hub holds once it has done it.
#[derive(Debug)]
struct Uploaded {
    note_count: i64,
    skipped: bool,
    /// After an accepted upload, the index the hub acknowledged. On the skip
    /// path, what the hub reported at the handshake — which is the same
    /// index, since that is what skipping means.
    hub_holds: HubHolds,
}

/// What the hub reports it holds, in the form the state file records. The
/// count is the hub's, never the local one.
fn hub_holds(state: Option<&VaultState>) -> HubHolds {
    match state.and_then(|s| s.holds.as_ref()) {
        Some(held) => HubHolds::Index {
            sha256: held.sha256.clone(),
            note_count: held.note_count,
        },
        None => HubHolds::Nothing,
    }
}

/// Send the export to the hub over the v5 wire: a JSON `UploadIndex`
/// declaring what follows, then the raw export bytes as one binary frame,
/// then the hub's `UploadAck`. No envelope, no compression, no chunking —
/// the hub hashes exactly the bytes in that frame.
async fn upload_index(
    ws: &mut WsStream,
    config_dir: &Path,
    vault_id: &str,
    this_vault: Option<&VaultState>,
    prepared: &PreparedExport,
) -> anyhow::Result<Uploaded> {
    if upload_decision(&prepared.hash, this_vault) == UploadDecision::Skip {
        eprintln!("Hub already holds this index, skipping upload");
        return Ok(Uploaded {
            note_count: 0,
            skipped: true,
            hub_holds: hub_holds(this_vault),
        });
    }

    send_json(ws, &ClientMsg::UploadIndex {
        vault_id: vault_id.to_string(),
        sha256: prepared.hash.clone(),
        note_count: prepared.note_count,
        schema_version: prepared.schema_version.clone(),
        model_id: prepared.model_id.clone(),
    })
    .await?;
    send_binary(ws, prepared.bytes.clone()).await?;
    eprintln!(
        "Sent local index ({} KB, {} notes declared)",
        prepared.bytes.len() / 1024,
        prepared.note_count
    );

    let acked_sha = match recv_json::<HubMsg>(ws).await? {
        // v5's UploadAck carries no count, so this line must not imply the hub
        // agreed with ours.
        HubMsg::UploadAck { vault_id, sha256 } => {
            eprintln!("Hub stored the index for {vault_id}");
            sha256
        }
        HubMsg::Reject { reason } => anyhow::bail!("hub rejected upload: {reason}"),
        other => anyhow::bail!("expected upload-ack, got: {other:?}"),
    };

    // We hashed these bytes ourselves, so we are the side holding ground
    // truth. A hub acknowledging a different index has stored something we
    // cannot account for; fail loud rather than write its claim into our own
    // state file.
    if acked_sha != prepared.hash {
        anyhow::bail!(
            "hub acknowledged a different index than we sent: we declared {}, it acked \
             {acked_sha}",
            prepared.hash,
        );
    }

    std::fs::write(
        last_export_mtime_path(config_dir),
        prepared.current_max_mtime.to_string(),
    )?;

    Ok(Uploaded {
        note_count: prepared.note_count,
        skipped: false,
        // Checked against the ack just above, so this is the index the hub
        // confirmed. The count is not: v5's UploadAck carries none, so it is
        // the count we declared alongside those bytes.
        hub_holds: HubHolds::Index {
            sha256: prepared.hash.clone(),
            note_count: prepared.note_count,
        },
    })
}

fn max_md_mtime(dir: &Path) -> u64 {
    let mut max = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.file_name().is_some_and(|n| n.to_str().is_some_and(|s| s.starts_with('.'))) {
                continue;
            }
            if path.is_dir() {
                max = max.max(max_md_mtime(&path));
            } else if path.extension().is_some_and(|e| e == "md") {
                if let Ok(meta) = path.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if let Ok(d) = modified.duration_since(std::time::UNIX_EPOCH) {
                            max = max.max(d.as_secs());
                        }
                    }
                }
            }
        }
    }
    max
}

pub(super) async fn send_json<T: serde::Serialize>(
    ws: &mut WsStream,
    msg: &T,
) -> anyhow::Result<()> {
    let text = serde_json::to_string(msg).map_err(SyncError::from)?;
    let to = send_timeout();
    tokio::time::timeout(to, ws.send(Message::text(text)))
        .await
        .map_err(|_| SyncError::SendTimeout { timeout: to })?
        .map_err(SyncError::from)?;
    Ok(())
}

async fn send_binary(ws: &mut WsStream, payload: Vec<u8>) -> anyhow::Result<()> {
    let to = send_timeout();
    tokio::time::timeout(to, ws.send(Message::binary(payload)))
        .await
        .map_err(|_| SyncError::SendTimeout { timeout: to })?
        .map_err(SyncError::from)?;
    Ok(())
}

pub(super) async fn recv_json<T: serde::de::DeserializeOwned>(
    ws: &mut WsStream,
) -> anyhow::Result<T> {
    loop {
        let recv_to = recv_timeout();
        let send_to = send_timeout();
        let msg = tokio::time::timeout(recv_to, ws.next())
            .await
            .map_err(|_| SyncError::RecvTimeout { timeout: recv_to })?
            .ok_or(SyncError::ClosedUnexpected)?
            .map_err(SyncError::from)?;
        match msg {
            Message::Text(text) => return Ok(serde_json::from_str(text.as_str()).map_err(SyncError::from)?),
            Message::Ping(data) => {
                tokio::time::timeout(send_to, ws.send(Message::Pong(data)))
                    .await
                    .map_err(|_| SyncError::SendTimeout { timeout: send_to })?
                    .map_err(SyncError::from)?;
            }
            Message::Close(_) => return Err(SyncError::ClosedUnexpected.into()),
            _ => continue,
        }
    }
}

/// Read the next binary frame, answering pings while it waits.
///
/// An `IndexHeader` that holds something promises exactly one binary frame,
/// so a text frame here is the hub breaking that promise rather than a
/// message to interpret.
pub(super) async fn recv_binary(ws: &mut WsStream) -> anyhow::Result<Vec<u8>> {
    loop {
        let recv_to = recv_timeout();
        let send_to = send_timeout();
        let msg = tokio::time::timeout(recv_to, ws.next())
            .await
            .map_err(|_| SyncError::RecvTimeout { timeout: recv_to })?
            .ok_or(SyncError::ClosedUnexpected)?
            .map_err(SyncError::from)?;
        match msg {
            Message::Binary(data) => return Ok(data.into()),
            Message::Text(_) => return Err(SyncError::FrameKind.into()),
            Message::Ping(data) => {
                tokio::time::timeout(send_to, ws.send(Message::Pong(data)))
                    .await
                    .map_err(|_| SyncError::SendTimeout { timeout: send_to })?
                    .map_err(SyncError::from)?;
            }
            Message::Close(_) => return Err(SyncError::ClosedUnexpected.into()),
            _ => continue,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::protocol_v5::HeldIndex;

    #[test]
    fn check_hub_scheme_accepts_wss() {
        assert!(check_hub_scheme("wss://hub.example.com/ws").is_ok());
        assert!(check_hub_scheme("wss://hub.example.com").is_ok());
    }

    #[test]
    fn check_hub_scheme_rejects_cleartext_ws_to_remote() {
        let err = check_hub_scheme("ws://hub.example.com/ws").unwrap_err().to_string();
        assert!(err.contains("ws://"), "error should name the scheme: {err}");
        assert!(check_hub_scheme("http://hub.example.com").is_err());
        assert!(check_hub_scheme("hub.example.com").is_err());
    }

    #[test]
    fn check_hub_scheme_allows_loopback_ws() {
        assert!(check_hub_scheme("ws://127.0.0.1:8080/ws").is_ok());
        assert!(check_hub_scheme("ws://localhost:9000").is_ok());
        assert!(check_hub_scheme("ws://[::1]:8080/ws").is_ok());
    }

    #[test]
    fn check_hub_scheme_allows_tailscale_cgnat_ws() {
        assert!(check_hub_scheme("ws://100.101.102.103:8787").is_ok());
        assert!(check_hub_scheme("ws://100.64.0.0:8787").is_ok());
        assert!(check_hub_scheme("ws://100.127.255.255:8787/ws").is_ok());
    }

    #[test]
    fn check_hub_scheme_allows_ts_net_hostname_ws() {
        assert!(check_hub_scheme("ws://my-hub.tailnet-name.ts.net:8787").is_ok());
    }

    #[test]
    fn check_hub_scheme_rejects_non_tailscale_ws() {
        assert!(check_hub_scheme("ws://8.8.8.8:1").is_err());
        assert!(check_hub_scheme("ws://100.63.255.255:8787").is_err());
        assert!(check_hub_scheme("ws://100.128.0.0:8787").is_err());
        assert!(check_hub_scheme("ws://hub.example.com:8787").is_err());
    }





    #[test]
    fn no_source_file_accepts_an_unauthenticated_hub() {
        // Needles assembled from parts so `include_str!` below — which pulls
        // in this very test — can't match its own assertion literals.
        let no_auth = concat!("no ", "auth");
        let mitm = concat!("MITM", "-vulnerable");
        let src = include_str!("client.rs");
        assert!(!src.contains(no_auth));
        assert!(!src.contains(mitm),
            "an unpinned hub is now an error, so there is nothing left to warn about");
    }


    fn held(sha256: &str) -> HeldIndex {
        HeldIndex { sha256: sha256.into(), note_count: 10, uploaded_at: 1 }
    }

    #[test]
    fn uploads_when_the_hub_holds_nothing_even_if_the_local_hash_matches() {
        let decision = upload_decision("abc123", Some(&VaultState {
            vault_id: "v1".into(),
            holds: None,
        }));

        assert_eq!(decision, UploadDecision::Upload,
            "THE 2026-07 OUTAGE: the client said 'no changes' from its own file \
             while the hub held nothing, for two months, at INFO level");
    }

    #[test]
    fn skips_only_when_the_hub_confirms_it_holds_this_exact_index() {
        let decision = upload_decision("abc123", Some(&VaultState {
            vault_id: "v1".into(),
            holds: Some(held("abc123")),
        }));
        assert_eq!(decision, UploadDecision::Skip);
    }

    #[test]
    fn uploads_when_the_hub_holds_a_different_index() {
        let decision = upload_decision("abc123", Some(&VaultState {
            vault_id: "v1".into(),
            holds: Some(held("stale999")),
        }));
        assert_eq!(decision, UploadDecision::Upload);
    }

    #[test]
    fn uploads_when_the_hub_does_not_mention_this_vault_at_all() {
        assert_eq!(upload_decision("abc123", None), UploadDecision::Upload,
            "a hub that never mentions the vault has not confirmed it holds the index");
    }

    /// The positive control deliberately looks for a token that exists only
    /// in the body. `state` would not do: it appears in the signature too, so
    /// a slice that captured the signature and truncated before the body
    /// would satisfy the control while checking none of the logic.
    #[test]
    fn the_local_hash_file_is_never_consulted_for_the_decision() {
        let src = include_str!("client.rs");
        let idx = src.find("pub fn upload_decision").expect("function exists");
        let body = src[idx..].split("\n}\n").next().expect("function has a closing brace");
        assert!(body.contains("UploadDecision::Skip"),
            "positive control: if this slice missed the function body, the assertion below \
             would pass by reading nothing");
        assert!(!body.contains("last-export-hash"),
            "the upload decision must depend only on what the hub reports");
    }

    type WsServer = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

    async fn spawn_mock_hub<F, Fut>(handler: F) -> std::net::SocketAddr
    where
        F: FnOnce(WsServer) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                if let Ok(ws) = tokio_tungstenite::accept_async(stream).await {
                    handler(ws).await;
                }
            }
        });
        addr
    }

    fn prepared_fixture(bytes: Vec<u8>) -> PreparedExport {
        let hash = hex::encode(Sha256::digest(&bytes));
        PreparedExport {
            bytes,
            hash,
            current_max_mtime: 7,
            note_count: 42,
            schema_version: "2".into(),
            model_id: "m".into(),
            result: None,
        }
    }

    async fn client_to(addr: std::net::SocketAddr) -> WsStream {
        tokio_tungstenite::connect_async(format!("ws://{addr}")).await.unwrap().0
    }

    #[tokio::test]
    async fn the_upload_is_a_json_declaration_then_one_raw_binary_frame() {
        let body = b"pretend-this-is-a-sqlite-file".to_vec();
        let expected_hash = hex::encode(Sha256::digest(&body));
        let (tx, rx) = tokio::sync::oneshot::channel();
        let addr = spawn_mock_hub(|mut ws| async move {
            let declared = match ws.next().await.unwrap().unwrap() {
                Message::Text(t) => serde_json::from_str::<ClientMsg>(t.as_str()).unwrap(),
                other => panic!("expected the upload-index declaration, got {other:?}"),
            };
            let frame = match ws.next().await.unwrap().unwrap() {
                Message::Binary(b) => b.to_vec(),
                other => panic!("expected one raw binary frame, got {other:?}"),
            };
            let ClientMsg::UploadIndex { ref vault_id, ref sha256, .. } = declared else {
                panic!("expected upload-index, got {declared:?}")
            };
            let ack = HubMsg::UploadAck { vault_id: vault_id.clone(), sha256: sha256.clone() };
            ws.send(Message::text(serde_json::to_string(&ack).unwrap())).await.unwrap();
            let _ = tx.send((declared, frame));
        })
        .await;

        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("federation")).unwrap();
        let mut config = FederationConfig::test_fixture("private", vec![]);
        config.vault_id = Some("v1".into());
        let prepared = prepared_fixture(body.clone());
        let mut ws = client_to(addr).await;

        let (vault_id, this_vault) = this_vault_state(&config, &[]).unwrap();
        let outcome = upload_index(&mut ws, dir.path(), vault_id, this_vault, &prepared)
            .await
            .unwrap();
        assert_eq!((outcome.note_count, outcome.skipped), (42, false));
        // The counterpart to the reject test: "must not advance" only means
        // something if a successful upload does advance it.
        assert_eq!(
            std::fs::read_to_string(last_export_mtime_path(dir.path())).unwrap(),
            "7",
        );

        let (declared, frame) = rx.await.unwrap();
        assert_eq!(frame, body,
            "the hub runs Sha256 over exactly this frame: no envelope header, no zstd, no chunking");
        match declared {
            ClientMsg::UploadIndex { vault_id, sha256, note_count, schema_version, model_id } => {
                assert_eq!(vault_id, "v1");
                assert_eq!(sha256, expected_hash);
                assert_eq!(note_count, 42);
                assert_eq!(schema_version, "2");
                assert_eq!(model_id, "m");
            }
            other => panic!("expected upload-index, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_hub_reject_fails_the_sync_with_the_hubs_reason() {
        let addr = spawn_mock_hub(|mut ws| async move {
            let _decl = ws.next().await;
            let _frame = ws.next().await;
            let reject = HubMsg::Reject { reason: "not authorized to write this vault".into() };
            ws.send(Message::text(serde_json::to_string(&reject).unwrap())).await.unwrap();
        })
        .await;

        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("federation")).unwrap();
        let mtime_path = last_export_mtime_path(dir.path());
        std::fs::write(&mtime_path, "1").unwrap();
        let mut config = FederationConfig::test_fixture("private", vec![]);
        config.vault_id = Some("v1".into());
        let mut ws = client_to(addr).await;

        let (vault_id, this_vault) = this_vault_state(&config, &[]).unwrap();
        let err =
            upload_index(&mut ws, dir.path(), vault_id, this_vault, &prepared_fixture(b"x".to_vec()))
                .await
                .unwrap_err()
                .to_string();
        assert!(err.contains("not authorized to write this vault"), "{err}");
        // The fixture's mtime is 7, so a swallowed reject would advance this to "7".
        assert_eq!(std::fs::read_to_string(&mtime_path).unwrap(), "1",
            "a rejected upload must not advance the re-export watermark");
    }

    #[tokio::test]
    async fn a_hub_that_acks_a_different_index_fails_the_upload() {
        let addr = spawn_mock_hub(|mut ws| async move {
            let _decl = ws.next().await;
            let _frame = ws.next().await;
            let ack = HubMsg::UploadAck {
                vault_id: "v1".into(),
                sha256: "beef".repeat(16),
            };
            ws.send(Message::text(serde_json::to_string(&ack).unwrap())).await.unwrap();
        })
        .await;

        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("federation")).unwrap();
        let mtime_path = last_export_mtime_path(dir.path());
        std::fs::write(&mtime_path, "1").unwrap();
        let mut config = FederationConfig::test_fixture("private", vec![]);
        config.vault_id = Some("v1".into());
        let prepared = prepared_fixture(b"x".to_vec());
        let mut ws = client_to(addr).await;

        let (vault_id, this_vault) = this_vault_state(&config, &[]).unwrap();
        let err = upload_index(&mut ws, dir.path(), vault_id, this_vault, &prepared)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains(&prepared.hash), "the error names what we sent: {err}");
        assert!(err.contains(&"beef".repeat(16)), "and what the hub acked: {err}");
        assert_eq!(std::fs::read_to_string(&mtime_path).unwrap(), "1",
            "an unaccountable ack must not advance the re-export watermark either");
    }

    /// The upload writes the re-export watermark and the next export reads
    /// it. Nothing checked that the two ends agreed on the file: if they ever
    /// name different paths the client re-exports on every single sync,
    /// forever, and no test and no log line says anything is wrong.
    #[tokio::test]
    async fn the_watermark_the_upload_writes_is_the_one_the_next_export_reads() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.db");
        let vault = dir.path().join("vault");
        super::super::export::build_source_db(
            &source,
            Some("01926d7e-0000-7000-8000-00000000000a"),
        );
        super::super::export::public_vault_with_note(&vault);
        let mut config = FederationConfig::test_fixture("private", vec![]);
        config.vault_id = Some("v1".into());

        let first = prepare_export(&source, &vault, dir.path(), &config).await.unwrap();
        assert!(first.result.is_some(), "precondition: a cold config dir exports");

        let addr = spawn_mock_hub(|mut ws| async move {
            let Message::Text(t) = ws.next().await.unwrap().unwrap() else { panic!("no decl") };
            let ClientMsg::UploadIndex { vault_id, sha256, .. } =
                serde_json::from_str(t.as_str()).unwrap()
            else {
                panic!("expected upload-index")
            };
            let _frame = ws.next().await.unwrap().unwrap();
            let ack = HubMsg::UploadAck { vault_id, sha256 };
            ws.send(Message::text(serde_json::to_string(&ack).unwrap())).await.unwrap();
        })
        .await;
        let mut ws = client_to(addr).await;
        let (vault_id, this_vault) = this_vault_state(&config, &[]).unwrap();
        upload_index(&mut ws, dir.path(), vault_id, this_vault, &first).await.unwrap();

        let second = prepare_export(&source, &vault, dir.path(), &config).await.unwrap();
        assert!(second.result.is_none(),
            "the vault has not changed, so the watermark the upload just wrote must \
             satisfy the next export's check");
    }

    /// Ties the three keys `prepare_export` reads to the three
    /// `export_index` writes, by running the real export instead of
    /// hand-building the table. Rename a key in `export.rs`, or change
    /// `params![exported.to_string()]` to `params![exported]` so it lands as
    /// INTEGER, and this goes red — a hand-built fixture agrees with whatever
    /// the reader expects and would stay green while every real sync failed.
    ///
    /// It cannot replace the hand-built test below: `export_index` always
    /// writes `schema_version = 2`, so a reader that returned the constant
    /// instead of the row would look right from here.
    #[tokio::test]
    async fn the_upload_metadata_matches_what_the_export_actually_wrote() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.db");
        let vault = dir.path().join("vault");
        super::super::export::build_source_db(
            &source,
            Some("01926d7e-0000-7000-8000-00000000000a"),
        );
        super::super::export::public_vault_with_note(&vault);

        let config = FederationConfig::test_fixture("private", vec![]);
        let prepared =
            prepare_export(&source, &vault, dir.path(), &config).await.unwrap();

        let exported = prepared.result.as_ref().expect("the export ran").exported;
        assert_eq!(exported, 1, "precondition: the fixture note is public and exports");
        assert_eq!(prepared.note_count, exported as i64);
        assert_eq!(prepared.model_id, "test-model");
        assert_eq!(prepared.schema_version, "2");
    }

    /// The declared metadata must describe the bytes on the wire, so it is
    /// read from the export DB — never from the source index, and never from
    /// a version constant. The export's own `SCHEMA_VERSION` is 2, so a
    /// fixture using 2 would pass whichever of the two the code read. This
    /// one uses 9.
    #[tokio::test]
    async fn the_upload_metadata_is_read_from_the_export_db() {
        let dir = tempfile::tempdir().unwrap();
        let export_path = export_db_path(dir.path());
        std::fs::create_dir_all(export_path.parent().unwrap()).unwrap();
        let conn = Connection::open(&export_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO meta VALUES ('note_count', '7'), ('schema_version', '9'),
                                     ('model_id', 'from-the-export');",
        )
        .unwrap();
        drop(conn);

        let vault = tempfile::tempdir().unwrap();
        let config = FederationConfig::test_fixture("private", vec![]);
        let prepared =
            prepare_export(&dir.path().join("no-such-source.db"), vault.path(), dir.path(), &config)
                .await
                .unwrap();

        assert!(prepared.result.is_none(), "precondition: the export was reused, not rebuilt");
        assert_eq!(prepared.note_count, 7);
        assert_eq!(prepared.schema_version, "9");
        assert_eq!(prepared.model_id, "from-the-export");
    }

    #[test]
    fn a_missing_vault_id_is_an_error_naming_ll_join() {
        let config = FederationConfig::test_fixture("private", vec![]);
        assert!(config.vault_id.is_none(), "fixture precondition");

        let err = this_vault_state(&config, &[]).unwrap_err().to_string();
        assert!(err.contains("ll join"),
            "ambiguous scope fails loud and names the fix, never defaults or skips: {err}");
    }

    #[test]
    fn the_hub_holding_nothing_is_recorded_as_nothing() {
        assert_eq!(hub_holds(None), HubHolds::Nothing,
            "a hub that never mentions the vault holds nothing for it");
        assert_eq!(
            hub_holds(Some(&VaultState { vault_id: "v1".into(), holds: None })),
            HubHolds::Nothing,
        );
    }

    #[test]
    fn the_recorded_count_is_the_hubs_not_the_local_one() {
        let state = VaultState { vault_id: "v1".into(), holds: Some(held("abc123")) };
        assert_eq!(
            hub_holds(Some(&state)),
            HubHolds::Index { sha256: "abc123".into(), note_count: 10 },
            "note_count is what the hub reports it holds; the local export's count \
             is a different number and answers a different question",
        );
    }

    #[test]
    fn the_vault_entry_is_the_one_matching_this_config() {
        let mut config = FederationConfig::test_fixture("private", vec![]);
        config.vault_id = Some("v2".into());
        let states = vec![
            VaultState { vault_id: "v1".into(), holds: Some(held("wrong")) },
            VaultState { vault_id: "v2".into(), holds: Some(held("right")) },
        ];

        let (vault_id, this_vault) = this_vault_state(&config, &states).unwrap();
        assert_eq!(vault_id, "v2");
        assert_eq!(this_vault.unwrap().holds.as_ref().unwrap().sha256, "right");
    }

    // -----------------------------------------------------------------
    // The TLS channel binding, over a real handshake
    // -----------------------------------------------------------------

    /// Roots a test has stood up, and the only way this crate trusts a
    /// certificate `webpki_roots` does not. Appended to, never cleared: two
    /// tests running in parallel each add their own, and an extra root that
    /// signs nothing any other test talks to changes nothing for them.
    type TrustAnchors = std::sync::Mutex<Vec<rustls::pki_types::CertificateDer<'static>>>;

    fn test_trust_anchors() -> &'static TrustAnchors {
        static ANCHORS: std::sync::OnceLock<TrustAnchors> = std::sync::OnceLock::new();
        ANCHORS.get_or_init(|| std::sync::Mutex::new(Vec::new()))
    }

    pub(super) fn extend_with_test_anchors(roots: &mut rustls::RootCertStore) {
        for der in test_trust_anchors().lock().unwrap().iter() {
            let _ = roots.add(der.clone());
        }
    }

    /// The claim the doc comment on `hub_tls_connector` makes — that no
    /// shipped binary contains an instruction that could widen the trust
    /// store — rests entirely on one `#[cfg(test)]`. Dropping that attribute
    /// compiles, passes every other test, and hands every build a root store
    /// that anything on the anchor list can enter. So the attribute is
    /// checked, not trusted.
    #[test]
    fn the_extra_root_exists_only_under_cfg_test() {
        let src = include_str!("client.rs");
        let call = concat!("tests::", "extend_with_test_anchors(&mut roots)");
        assert_eq!(
            src.matches(call).count(),
            1,
            "positive control: exactly one literal call site, or the check below \
             inspects the first of several",
        );
        let before = &src[..src.find(call).expect("the call site is in this file")];
        assert!(
            before.trim_end().ends_with("#[cfg(test)]"),
            "the extra trust anchor must be gated on cfg(test); without that \
             attribute every release build carries a way to trust a root \
             webpki does not",
        );
    }

    /// The three `export_keying_material` parameters, as the cross-repo
    /// transcript states them. Only the label is a named constant on this
    /// side; the length and the context are call arguments in
    /// `connect_and_authenticate`, so nothing but a live handshake can pin
    /// them. This is the client's twin of the hub's
    /// `tls::tests::the_exporter_matches_the_transcripts_label_length_and_context`.
    fn transcript_exporter_params() -> (Vec<u8>, usize, Option<Vec<u8>>) {
        let t: serde_json::Value =
            serde_json::from_str(include_str!("federation-v5-transcript.json"))
                .expect("the transcript is valid JSON");
        let ex = &t["tls_exporter"];
        let label = ex["label"].as_str().expect("tls_exporter.label").as_bytes().to_vec();
        let length = ex["length"].as_u64().expect("tls_exporter.length") as usize;
        let context = match &ex["context"] {
            serde_json::Value::Null => None,
            serde_json::Value::String(s) => Some(s.as_bytes().to_vec()),
            other => panic!("tls_exporter.context is a string or null, got {other:?}"),
        };
        (label, length, context)
    }

    /// A hub that speaks TLS, whose certificate this process trusts because
    /// the test just put it on the anchor list.
    struct TlsHub {
        addr: std::net::SocketAddr,
        signer: SigningKey,
        /// The self-signed certificate this hub serves. Nothing trusts it
        /// until a test calls [`TlsHub::trust`] — which is what lets the
        /// untrusted case be the same hub with one line left out, rather
        /// than a second mock that could differ in some other way.
        cert: rustls::pki_types::CertificateDer<'static>,
        /// The exporter the hub derived from its own end of the session,
        /// using the transcript's label, length and context. `None` until a
        /// client has completed a TLS handshake against it.
        derived: std::sync::Arc<std::sync::Mutex<Option<[u8; 32]>>>,
        /// What the hub answered the client with, or why it stopped. A mock
        /// that panicked inside `tokio::spawn` would fail nothing.
        outcome: std::sync::Arc<std::sync::Mutex<Option<Result<(), String>>>>,
    }

    /// Serve one TLS WebSocket connection and run the happy path over it.
    ///
    /// The hub signs its challenge with the exporter IT derived. The client
    /// derives its own, in production code, and verifies that signature
    /// against it — so a completed handshake is the assertion that both ends
    /// produced the same 32 bytes, and a client that fell back to
    /// `[0u8; 32]` fails it.
    async fn spawn_tls_hub() -> TlsHub {
        use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

        let issued = rcgen::generate_simple_self_signed(vec!["127.0.0.1".to_string()])
            .expect("rcgen mints a certificate for the loopback address");
        let cert_der: CertificateDer<'static> = issued.cert.der().clone();
        let key_der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            issued.signing_key.serialize_der(),
        ));

        let server_config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert_der.clone()], key_der)
            .expect("the certificate and its own key agree");
        let acceptor = tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(server_config));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let signer = SigningKey::from_bytes(&[3u8; 32]);
        let hub_signer = signer.clone();
        let derived = std::sync::Arc::new(std::sync::Mutex::new(None));
        let derived_out = std::sync::Arc::clone(&derived);
        let outcome = std::sync::Arc::new(std::sync::Mutex::new(None));
        let outcome_out = std::sync::Arc::clone(&outcome);

        tokio::spawn(async move {
            let result = serve_one_tls_client(listener, acceptor, hub_signer, derived_out).await;
            *outcome_out.lock().unwrap() = Some(result);
        });

        TlsHub { addr, signer, cert: cert_der, derived, outcome }
    }

    impl TlsHub {
        /// Put this hub's certificate on the anchor list. Appended, never
        /// removed: an anchor is only ever an issuer, and no certificate but
        /// this hub's own chains to it, so a leftover from an earlier test
        /// cannot rescue a later one.
        fn trust(&self) {
            test_trust_anchors().lock().unwrap().push(self.cert.clone());
        }
    }

    async fn serve_one_tls_client(
        listener: tokio::net::TcpListener,
        acceptor: tokio_rustls::TlsAcceptor,
        signer: SigningKey,
        derived: std::sync::Arc<std::sync::Mutex<Option<[u8; 32]>>>,
    ) -> Result<(), String> {
        use ed25519_dalek::Signer;

        use super::super::handshake::{b64, random_nonce, unb64};
        use super::super::protocol_v5::{
            client_auth_message, hub_challenge_message, PROTOCOL_VERSION,
        };

        let (tcp, _) = listener.accept().await.map_err(|e| format!("accept: {e}"))?;
        let tls = acceptor.accept(tcp).await.map_err(|e| format!("tls handshake: {e}"))?;

        // Derive from the transcript's own numbers, not from this crate's
        // constants. The client derives from its constants; agreement is the
        // pin, and it covers all three parameters at once.
        let (label, length, context) = transcript_exporter_params();
        let mut out = vec![0u8; length];
        {
            let (_io, conn) = tls.get_ref();
            conn.export_keying_material(&mut out[..], &label, context.as_deref())
                .map_err(|e| format!("export_keying_material: {e}"))?;
        }
        let exporter: [u8; 32] = out
            .try_into()
            .map_err(|_| "the transcript's exporter length is not what the handshake signs over"
                .to_string())?;
        *derived.lock().unwrap() = Some(exporter);

        let mut ws = tokio_tungstenite::accept_async(tls)
            .await
            .map_err(|e| format!("websocket upgrade: {e}"))?;

        let hello = match ws.next().await {
            Some(Ok(Message::Text(t))) => serde_json::from_str::<ClientMsg>(t.as_str())
                .map_err(|e| format!("client-hello: {e}"))?,
            other => return Err(format!("expected a client-hello, got {other:?}")),
        };
        let ClientMsg::ClientHello { key_id, nonce_c, .. } = hello else {
            return Err(format!("expected a client-hello, got {hello:?}"));
        };
        let nonce_c = unb64(&nonce_c).map_err(|e| format!("nonce_c: {e}"))?;
        let nonce_h = random_nonce();
        let hub_key_id =
            KeyId::from_pubkey(&signer.verifying_key()).as_str().to_string();
        let sig_h = signer.sign(&hub_challenge_message(&nonce_h, &nonce_c, &exporter));
        let challenge = HubMsg::HubChallenge {
            nonce_h: b64(&nonce_h),
            hub_key_id: hub_key_id.clone(),
            sig_h: b64(&sig_h.to_bytes()),
        };
        ws.send(Message::text(serde_json::to_string(&challenge).unwrap()))
            .await
            .map_err(|e| format!("send hub-challenge: {e}"))?;

        let auth = match ws.next().await {
            Some(Ok(Message::Text(t))) => serde_json::from_str::<ClientMsg>(t.as_str())
                .map_err(|e| format!("client-auth: {e}"))?,
            other => return Err(format!("expected a client-auth, got {other:?}")),
        };
        let ClientMsg::ClientAuth { sig_c } = auth else {
            return Err(format!("expected a client-auth, got {auth:?}"));
        };
        // The client's half of the binding: its signature covers the same
        // exporter, so verifying it here proves the agreement in the other
        // direction too.
        let client_key = KeyId::parse(&key_id).map_err(|e| format!("client key_id: {e}"))?;
        client_key
            .verify(
                &client_auth_message(&nonce_h, &nonce_c, &hub_key_id, &exporter),
                &unb64(&sig_c).map_err(|e| format!("sig_c: {e}"))?,
            )
            .map_err(|e| format!("client signature did not verify: {e}"))?;

        let ready = HubMsg::SyncReady {
            protocol_version: PROTOCOL_VERSION,
            vault_state: vec![],
            grants: vec![],
            revocations: vec![],
        };
        ws.send(Message::text(serde_json::to_string(&ready).unwrap()))
            .await
            .map_err(|e| format!("send sync-ready: {e}"))?;
        Ok(())
    }

    fn config_for(hub: &TlsHub) -> FederationConfig {
        let mut config = FederationConfig::test_fixture("private", vec![]);
        config.hub.endpoint = format!("wss://{}", hub.addr);
        config.hub.key_id =
            Some(KeyId::from_pubkey(&hub.signer.verifying_key()).as_str().to_string());
        config.vault_id = Some("v1".into());
        config
    }

    /// **The arm that had never run.** Every other test in this crate reaches
    /// `connect_and_authenticate` over cleartext loopback and takes the
    /// `LL_ALLOW_INSECURE_WS` `[0u8; 32]` branch; nothing had ever driven the
    /// `MaybeTlsStream::Rustls` branch, because `connect_async` offered no way
    /// to trust a certificate minted here.
    ///
    /// Success proves the branch ran, and nothing in the process environment
    /// can make it prove that falsely. `LL_ALLOW_INSECURE_WS` is not consulted
    /// here at all — the `Rustls` arm is matched before the guard that reads
    /// it, and this connection is `wss://`. What rules out the insecure branch
    /// is the signature: the hub signs its challenge with the exporter it
    /// derived from a live TLS session, asserted below to be something other
    /// than 32 zero bytes, and a client holding zeros fails to verify it.
    #[tokio::test]
    async fn the_client_derives_the_channel_binding_from_a_real_tls_session() {
        let hub = spawn_tls_hub().await;
        hub.trust();
        let seed = SigningKey::from_bytes(&[9u8; 32]);
        let config = config_for(&hub);

        let (_ws, ready) =
            connect_and_authenticate(&config, &seed, "peer", "model", None)
                .await
                .expect("the handshake completes over TLS");

        assert_eq!(ready.protocol_version, super::super::protocol_v5::PROTOCOL_VERSION);
        assert_eq!(
            hub.outcome.lock().unwrap().clone(),
            Some(Ok(())),
            "the hub ran the whole exchange, including verifying the client's own \
             signature over the exporter",
        );
        let derived = hub.derived.lock().unwrap().expect("the hub derived an exporter");
        assert_ne!(
            derived, [0u8; 32],
            "a TLS exporter of 32 zero bytes would make this test pass for a client \
             that never derived one",
        );
    }

    /// The same handshake with the trust anchor withheld. Without it the
    /// client offers only the webpki roots, which never signed this
    /// certificate — so the test above is passing because of the injection
    /// point and not because a `wss://` connection to loopback would have
    /// worked anyway.
    #[tokio::test]
    async fn an_untrusted_hub_certificate_is_refused() {
        // The same hub as above, minus the one line that trusts it.
        let hub = spawn_tls_hub().await;

        let seed = SigningKey::from_bytes(&[9u8; 32]);
        let err = connect_and_authenticate(&config_for(&hub), &seed, "peer", "model", None)
            .await
            .expect_err("an unknown issuer must not complete a handshake")
            .to_string();
        assert!(
            err.contains("failed to connect to hub"),
            "the refusal happens at the TLS handshake, before any hub message: {err}",
        );
    }
}
