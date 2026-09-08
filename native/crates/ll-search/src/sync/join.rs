//! `ll join`: an invite code in, a vault enrolled on a hub out — and
//! nothing written to `config.json` unless the whole thing worked.
//!
//! The order of the steps is the design. The hub redeems an invite while
//! handling `ClientHello`, before it signs anything, so the fingerprint has
//! to be confirmed before the connection opens: a code offered to an
//! impostor is a code already burned. And `config.json` is written last,
//! after the hub has proved its identity and admitted ours, so a join that
//! dies anywhere in the middle leaves a directory a re-run can enter cleanly
//! rather than a half-state nobody designed.
//!
//! Two things the plan asks for that are deliberately absent:
//!
//! - **No separate vault registration.** The hub creates the `vaults` row for
//!   every `vault_id` declared in `ClientHello`, once the client signature
//!   verifies. Declaring it IS registering it; there is no wire message for
//!   anything else and no round trip to add. Locally, `join` does not write a
//!   vault profile either — writing `config.json` registers the root vault,
//!   `ll vault add` registers every other one, and the case in between is
//!   refused rather than joined: see
//!   `require_a_profile_if_this_is_not_the_root`.
//! - **No recovery grant is signed here, and it is not signed never.**
//!   `Confirm::recovery_phrase` shows the words and `recovery_key_id` keeps
//!   the public half, because neither can be reconstructed later. The `link`
//!   that makes the recovery key usable is `link.rs`'s
//!   `ensure_recovery_link`: it reads `recovery_key_id` back out of
//!   `config.json` and issues the grant on the next reconcile, so the words
//!   are real from the moment they are shown and usable from this machine's
//!   first sync. This bullet used to say that grant *could not* be created —
//!   `ClientMsg` had no variant submitting one and there was no local grant
//!   store. Both exist, and the prompt below says so to the person deciding
//!   how carefully to keep the words.

use std::path::Path;

use ed25519_dalek::SigningKey;
use rand::RngCore;
use zeroize::Zeroizing;

use super::client::{check_hub_scheme, connect_and_authenticate};
use super::config::{
    self, FederationConfig, HubEndpoint, Identity, VisibilityConfig,
};
use super::key_id::KeyId;
use super::protocol_v5::PROTOCOL_VERSION;
use super::{auth, registry, seed_store, well_known, words};

/// What a completed join produced. `recovery_phrase` is the only copy of the
/// recovery secret that will ever exist; the caller shows it and forgets it.
///
/// `Debug` is hand-written to redact that field. The derived one would put 24
/// recovery words into any log line that formatted this struct, on a `pub`
/// type, while the seed it came from is carefully `Zeroizing` three lines
/// away.
#[derive(Clone)]
pub struct JoinOutcome {
    pub key_id: String,
    pub recovery_phrase: String,
    pub recovery_key_id: String,
    pub hub_key_id: String,
    pub hub_fingerprint: String,
    pub vault_id: String,
}

impl std::fmt::Debug for JoinOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JoinOutcome")
            .field("key_id", &self.key_id)
            .field("recovery_phrase", &"<redacted>")
            .field("recovery_key_id", &self.recovery_key_id)
            .field("hub_key_id", &self.hub_key_id)
            .field("hub_fingerprint", &self.hub_fingerprint)
            .field("vault_id", &self.vault_id)
            .finish()
    }
}

/// The two checks `join` cannot make on the user's behalf. Both are
/// out-of-band by nature: one compares the hub's fingerprint against a
/// channel this program cannot see, and the other confirms a human wrote 24
/// words onto something that is not this disk.
pub trait Confirm {
    /// Returns false to abort. Nothing has been sent to the hub yet at this
    /// point, and nothing has been written.
    fn hub_fingerprint(&mut self, fingerprint: &str, hub_key_id: &str) -> anyhow::Result<bool>;

    /// Returns false to abort. Called once, with the only copy of the phrase.
    fn recovery_phrase(&mut self, phrase: &str) -> anyhow::Result<bool>;
}

/// Prompts on stderr, reads from stdin. Anything but an explicit yes — a
/// blank line, EOF, a closed pipe — is a no.
pub struct TtyConfirm;

impl TtyConfirm {
    fn ask(question: &str) -> anyhow::Result<bool> {
        use std::io::{BufRead, Write};
        eprint!("{question} [y/N] ");
        std::io::stderr().flush()?;
        let mut line = String::new();
        if std::io::stdin().lock().read_line(&mut line)? == 0 {
            return Ok(false);
        }
        Ok(matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes"))
    }
}

impl Confirm for TtyConfirm {
    fn hub_fingerprint(&mut self, fingerprint: &str, hub_key_id: &str) -> anyhow::Result<bool> {
        eprintln!();
        eprintln!("  hub identity: {hub_key_id}");
        eprintln!("  fingerprint:  {fingerprint}");
        eprintln!();
        eprintln!("Anyone who can answer for this address can present a key here.");
        eprintln!("These six words are how you tell the real hub from that.");
        Self::ask("Do they match the six words the hub operator gave you?")
    }

    fn recovery_phrase(&mut self, phrase: &str) -> anyhow::Result<bool> {
        eprintln!();
        eprintln!("Recovery phrase — 24 words, shown once and stored nowhere:");
        eprintln!();
        eprintln!("  {phrase}");
        eprintln!();
        eprintln!("Write it down offline. They are a key of your own: run");
        eprintln!("`ll-search recover \"<the 24 words>\"` on a machine that has lost its");
        eprintln!("identity, and this machine's next sync is what lodges the grant that");
        eprintln!("lets that key in. Nothing on disk holds the words, so losing them is");
        eprintln!("final.");
        Self::ask("Have you written it down?")
    }
}

/// Enroll `vault_path` on the hub at `hub_endpoint` using `invite_code`,
/// storing everything under `config_dir`.
pub async fn join(
    config_dir: &Path,
    hub_endpoint: &str,
    invite_code: &str,
    vault_path: &Path,
    confirm: &mut dyn Confirm,
) -> anyhow::Result<JoinOutcome> {
    let config_path = config::config_path(config_dir);
    if config_path.exists() {
        anyhow::bail!(
            "{} already exists — this vault has joined a hub already. Delete it to \
             join again, and expect a fresh vault_id: the hub's copy of the old one \
             is not carried across.",
            config_path.display()
        );
    }
    require_a_profile_if_this_is_not_the_root(config_dir)?;

    check_hub_scheme(hub_endpoint)?;

    let hub = well_known::fetch(hub_endpoint).await?;
    if hub.protocol_version != PROTOCOL_VERSION {
        anyhow::bail!(
            "hub speaks protocol v{}, this client speaks v{PROTOCOL_VERSION}. \
             There is no negotiation and no downgrade; upgrade one side.",
            hub.protocol_version
        );
    }
    let hub_key = KeyId::parse(&hub.hub_key_id)?;
    let fingerprint = words::fingerprint(&hub_key);
    if !confirm.hub_fingerprint(&fingerprint, hub_key.as_str())? {
        anyhow::bail!("hub fingerprint not confirmed; nothing was sent and nothing written");
    }

    let identity = seed_store::load_or_create(config_dir)?;
    let key_id = KeyId::from_pubkey(&identity.signing_key.verifying_key());

    let mut recovery_seed = Zeroizing::new([0u8; 32]);
    rand::thread_rng().fill_bytes(recovery_seed.as_mut());
    let recovery_key_id =
        KeyId::from_pubkey(&SigningKey::from_bytes(&recovery_seed).verifying_key());
    let recovery_phrase = words::recovery_phrase(&recovery_seed)?;
    if !confirm.recovery_phrase(&recovery_phrase)? {
        anyhow::bail!("recovery phrase not confirmed; nothing was sent and nothing written");
    }

    let vault_id = uuid::Uuid::now_v7().to_string();
    let config = FederationConfig {
        identity: Identity {
            display_name: display_name_for(vault_path),
            pubkey: auth::pubkey_b64(&identity.signing_key),
        },
        visibility: VisibilityConfig { default: "private".into(), rules: Vec::new() },
        hub: HubEndpoint {
            endpoint: hub_endpoint.to_string(),
            key_id: Some(hub.hub_key_id.clone()),
        },
        vault_id: Some(vault_id.clone()),
        vault_path: Some(vault_path.display().to_string()),
        recovery_key_id: Some(recovery_key_id.as_str().to_string()),
    };

    // The round trip. `authenticate` re-checks the pinned key against the one
    // the hub presents, so a hub that publishes one identity and signs with
    // another dies here rather than at the fingerprint the user just read.
    let (mut ws, ready) = connect_and_authenticate(
        &config,
        &identity.signing_key,
        &config.identity.display_name,
        // Not "unknown". Join happens before this vault has an index, but the
        // model this client embeds with is known statically, and the hub
        // records what it is told here.
        &crate::model::KnownModel::BgeSmallEnV15.config().model_id,
        Some(invite_code),
    )
    .await?;
    let _ = futures_util::SinkExt::close(&mut ws).await;

    // The hub creates the `vaults` row from the id declared in `ClientHello`,
    // after the signature verifies, and `SyncReady` is its own statement that
    // it did. Discarding that turns the registration into a hope: a hub that
    // admits the key without creating the row produces a join that looks
    // entirely successful and a first sync that is refused, with the cause a
    // repository away.
    if !ready.vault_state.iter().any(|v| v.vault_id == vault_id) {
        anyhow::bail!(
            "hub authenticated this key but did not register vault {vault_id}; \
             refusing to write a config for a vault it will not accept uploads for"
        );
    }

    config::write_config(config_dir, &config)?;

    Ok(JoinOutcome {
        key_id: key_id.as_str().to_string(),
        recovery_phrase,
        recovery_key_id: recovery_key_id.as_str().to_string(),
        hub_key_id: hub.hub_key_id,
        hub_fingerprint: fingerprint,
        vault_id,
    })
}

/// Refuse a config dir that sits under a plugin data root without a vault
/// profile naming it.
///
/// `join` cannot create the profile itself — `registry::add` needs the plugin
/// data root and `join` is handed a config dir — and for the root vault there
/// is nothing to create: `registry::load`'s legacy branch reads
/// `federation/config.json` directly, so writing that file registers it. What
/// is left is the middle case, a second vault whose `ll vault add` never ran.
/// It would otherwise produce a perfectly working config in a directory the
/// registry cannot see, which is the kind of thing found months later.
///
/// The parent tells the three cases apart. A plugin data root holds a registry,
/// a legacy config, or both; a directory whose parent holds neither IS the
/// root.
pub(super) fn require_a_profile_if_this_is_not_the_root(config_dir: &Path) -> anyhow::Result<()> {
    let Some(parent) = config_dir.parent() else { return Ok(()) };
    let has_registry = parent.join("vaults.json").exists();
    if !has_registry && !config::config_path(parent).exists() {
        return Ok(());
    }
    // With a registry present `registry::load` reads only the registry doc, so
    // this cannot trip over a legacy config that has no vault_path.
    let named = has_registry
        && registry::load(parent)?.iter().any(|p| same_dir(&p.config_dir, config_dir));
    if !named {
        anyhow::bail!(
            "{} sits under the plugin data root {} but no vault profile names it. \
             Run `ll vault add <vault-path> <id>` first — that is what creates the \
             registry entry, and `ll join` only creates the identity. A vault the \
             registry cannot see is one no later command can find.",
            config_dir.display(),
            parent.display(),
        );
    }
    Ok(())
}

/// Compare two directory paths by their canonical form where the filesystem
/// can supply one, so a symlinked or trailing-slash `--config-dir` still
/// matches the profile that names it.
fn same_dir(a: &Path, b: &Path) -> bool {
    let canonical = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canonical(a) == canonical(b)
}

/// A label for this vault, from its directory name. Reduced to ASCII
/// alphanumerics, `-` and `_`, which is what the sync client's peer-name
/// validator accepts — this string travels in peer metadata and a name it
/// rejects would be dropped there with no explanation here.
pub(super) fn display_name_for(vault_path: &Path) -> String {
    let cleaned: String = vault_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if cleaned.is_empty() { "vault".to_string() } else { cleaned }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::config::load_config;
    use crate::sync::test_hub::{
        self, fake_hub_happy_path, fake_hub_happy_path_signed_by,
        fake_hub_that_forgets_the_vault, fake_hub_that_rejects_the_invite, hub_key_id_str, HubVaults,
        MockHub,
    };
    use crate::sync::protocol_v5::ClientMsg;
    use std::path::Path;
    use std::sync::MutexGuard;

    /// Answers yes to everything, and records what it was shown.
    #[derive(Default)]
    struct Yes {
        fingerprint: Option<String>,
        phrase: Option<String>,
    }

    impl Confirm for Yes {
        fn hub_fingerprint(&mut self, fingerprint: &str, _key: &str) -> anyhow::Result<bool> {
            self.fingerprint = Some(fingerprint.to_string());
            Ok(true)
        }
        fn recovery_phrase(&mut self, phrase: &str) -> anyhow::Result<bool> {
            self.phrase = Some(phrase.to_string());
            Ok(true)
        }
    }

    /// Says no at exactly one step and yes at the other.
    struct DeclineAt {
        step: Step,
        reached: Option<Step>,
    }

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum Step {
        Fingerprint,
        Phrase,
    }

    impl DeclineAt {
        fn new(step: Step) -> Self {
            DeclineAt { step, reached: None }
        }
    }

    impl Confirm for DeclineAt {
        fn hub_fingerprint(&mut self, _fingerprint: &str, _key: &str) -> anyhow::Result<bool> {
            self.reached = Some(Step::Fingerprint);
            Ok(self.step != Step::Fingerprint)
        }
        fn recovery_phrase(&mut self, _phrase: &str) -> anyhow::Result<bool> {
            self.reached = Some(Step::Phrase);
            Ok(self.step != Step::Phrase)
        }
    }

    /// A join test touches two process-wide globals: `LL_SEED_BACKEND`, so no
    /// test reaches the OS keyring, and `LL_ALLOW_INSECURE_WS`, which the
    /// client needs before it will authenticate over the non-TLS mock. Hold
    /// the shared lock for the duration rather than racing every other test
    /// that reads either one.
    /// Both writes happen under the guard. `force_encrypted_seed_backend`
    /// sets `LL_SEED_BACKEND`, so calling it before taking the lock puts the
    /// one env write the lock exists for outside the lock — which is the
    /// ordering bug this shape is meant to prevent, committed by the helper
    /// that prevents it everywhere else.
    fn insecure_ws_env() -> InsecureWsEnv {
        let guard = test_hub::env_lock();
        test_hub::force_encrypted_seed_backend();
        std::env::set_var("LL_ALLOW_INSECURE_WS", "1");
        InsecureWsEnv { _guard: guard }
    }

    /// Clears the variable when the lock is released, so a later test in this
    /// binary sees the environment it expects rather than the one the last
    /// join test happened to leave. Leaving it set is harmless for the tests
    /// that exist today and is a trap for the next one that reads it.
    struct InsecureWsEnv {
        _guard: MutexGuard<'static, ()>,
    }

    impl Drop for InsecureWsEnv {
        fn drop(&mut self) {
            std::env::remove_var("LL_ALLOW_INSECURE_WS");
        }
    }

    fn hello_of(hub: &MockHub) -> Option<(Vec<String>, Option<String>, String)> {
        match hub.last_hello()? {
            ClientMsg::ClientHello { vault_ids, invite_code, key_id, .. } => {
                Some((vault_ids, invite_code, key_id))
            }
            _ => None,
        }
    }

    #[tokio::test]
    async fn writes_config_only_after_a_successful_round_trip() {
        let _env = insecure_ws_env();
        let hub = fake_hub_that_rejects_the_invite().await;
        let dir = tempfile::tempdir().unwrap();

        let err = join(dir.path(), &hub.ws_url(), "BAD-CODE", Path::new("/v"), &mut Yes::default())
            .await
            .unwrap_err();

        assert!(err.to_string().contains("invite redemption failed"), "{err}");
        assert!(!config::config_path(dir.path()).exists(),
            "a failed join must leave no config, so re-running enters cleanly");
    }

    /// Authentication succeeding is not registration succeeding. Under v5 the
    /// hello IS the registration, and `SyncReady` is the hub's own statement
    /// that it happened — so a hub that admits the key and reports no vaults
    /// has dropped it, and a config written here would produce a join that
    /// looked entirely successful and a first upload refused for a reason
    /// living in another repository.
    #[tokio::test]
    async fn a_hub_that_authenticates_but_registers_nothing_is_not_a_successful_join() {
        let _env = insecure_ws_env();
        let hub = fake_hub_that_forgets_the_vault().await;
        let dir = tempfile::tempdir().unwrap();

        let err = join(dir.path(), &hub.ws_url(), "CODE", Path::new("/v"), &mut Yes::default())
            .await
            .unwrap_err();

        assert!(err.to_string().contains("did not register vault"), "{err}");
        assert!(!config::config_path(dir.path()).exists(),
            "no config for a vault the hub will not accept uploads for");
    }

    #[tokio::test]
    async fn writes_config_once_the_round_trip_succeeds() {
        // The complement of the test above. Without it, a `join` that never
        // writes a config at all satisfies the failure case perfectly.
        let _env = insecure_ws_env();
        let hub = fake_hub_happy_path(HubVaults::new()).await;
        let dir = tempfile::tempdir().unwrap();

        join(dir.path(), &hub.ws_url(), "GOOD-CODE", Path::new("/v"), &mut Yes::default())
            .await
            .unwrap();

        assert!(config::config_path(dir.path()).exists());
    }

    #[tokio::test]
    async fn pins_the_hub_key_it_fetched() {
        let _env = insecure_ws_env();
        let hub = fake_hub_happy_path(HubVaults::new()).await;
        let dir = tempfile::tempdir().unwrap();

        join(dir.path(), &hub.ws_url(), "GOOD-CODE", Path::new("/v"), &mut Yes::default())
            .await
            .unwrap();

        let cfg = load_config(dir.path()).unwrap();
        assert_eq!(cfg.hub.key_id.as_deref(), Some(hub.key_id.as_str()));
    }

    /// The pin has to be the key that was *fetched and confirmed*, not
    /// whatever key turns up on the WebSocket. This hub publishes the genuine
    /// identity at `/.well-known/ll-hub` — the one whose fingerprint the user
    /// read and approved — and then signs the challenge with a different key
    /// it holds legitimately. Only a real comparison catches it; an
    /// implementation that pins what it was presented sails through.
    #[tokio::test]
    async fn refuses_a_hub_that_signs_with_a_key_it_did_not_publish() {
        let _env = insecure_ws_env();
        let other = SigningKey::from_bytes(&[9u8; 32]);
        let hub = fake_hub_happy_path_signed_by(other, &hub_key_id_str(), HubVaults::new()).await;
        let dir = tempfile::tempdir().unwrap();

        let err = join(dir.path(), &hub.ws_url(), "GOOD-CODE", Path::new("/v"), &mut Yes::default())
            .await
            .unwrap_err();

        assert!(err.to_string().contains("hub key mismatch"), "{err}");
        assert!(!config::config_path(dir.path()).exists());
    }

    #[tokio::test]
    async fn shows_the_fingerprint_of_the_key_it_pins() {
        let _env = insecure_ws_env();
        let hub = fake_hub_happy_path(HubVaults::new()).await;
        let dir = tempfile::tempdir().unwrap();
        let mut confirm = Yes::default();

        let out = join(dir.path(), &hub.ws_url(), "GOOD-CODE", Path::new("/v"), &mut confirm)
            .await
            .unwrap();

        let expected = words::fingerprint(&KeyId::parse(&hub.key_id).unwrap());
        assert_eq!(confirm.fingerprint.as_deref(), Some(expected.as_str()),
            "the six words the user compares must be derived from the key that ends \
             up pinned, or the comparison guards nothing");
        assert_eq!(out.hub_fingerprint, expected);
    }

    #[tokio::test]
    async fn generates_a_recovery_key_linked_to_the_identity() {
        let _env = insecure_ws_env();
        let hub = fake_hub_happy_path(HubVaults::new()).await;
        let dir = tempfile::tempdir().unwrap();

        let out = join(dir.path(), &hub.ws_url(), "GOOD-CODE", Path::new("/v"), &mut Yes::default())
            .await
            .unwrap();

        assert_eq!(out.recovery_phrase.split_whitespace().count(), 24);

        // The link the test's name claims: the phrase must encode the seed of
        // the very key recorded in the config. A word count agrees with any
        // 24 words at all, including a phrase for a key nobody kept.
        let seed = words::seed_from_phrase(&out.recovery_phrase).unwrap();
        let from_phrase = KeyId::from_pubkey(&SigningKey::from_bytes(&seed).verifying_key());
        let cfg = load_config(dir.path()).unwrap();
        assert_eq!(cfg.recovery_key_id.as_deref(), Some(from_phrase.as_str()));
        assert_eq!(out.recovery_key_id, from_phrase.as_str());

        let written = std::fs::read_to_string(config::config_path(dir.path())).unwrap();
        assert!(!written.contains(&out.recovery_phrase),
            "the recovery secret must never be written to disk in usable form");
        // A single BIP-39 word is an ordinary English word, and every
        // `config.json` this writes legitimately contains seven of them inside
        // quoted keys and values: display, end, hub, key, private, rule, vault.
        // Searching for `"<word>` therefore went red whenever a drawn phrase
        // happened to include one of the seven — 1 - (1 - 7/2048)^24, about one
        // run in thirteen, and it does not depend on parallelism or on anything
        // else in the suite.
        //
        // Two ADJACENT words in order cannot appear by coincidence, and they
        // are also the smallest thing that is genuinely a fragment of the
        // secret rather than a word that happens to be in both places. A
        // truncated or partial write still fails here.
        let words: Vec<&str> = out.recovery_phrase.split_whitespace().collect();
        for pair in words.windows(2) {
            let fragment = pair.join(" ");
            assert!(!written.contains(&fragment),
                "a fragment of the recovery phrase ({fragment:?}) reached the config");
        }
    }

    #[tokio::test]
    async fn declares_the_vault_id_in_the_hello_because_that_is_the_registration() {
        let _env = insecure_ws_env();
        let hub = fake_hub_happy_path(HubVaults::new()).await;
        let dir = tempfile::tempdir().unwrap();

        let out = join(dir.path(), &hub.ws_url(), "GOOD-CODE", Path::new("/v"), &mut Yes::default())
            .await
            .unwrap();

        let (vault_ids, invite, key_id) = hello_of(&hub).expect("hub saw a client-hello");
        assert_eq!(vault_ids, vec![out.vault_id.clone()],
            "the hub creates the vaults row from what the hello declares; a join that \
             declares nothing registers nothing");
        assert_eq!(invite.as_deref(), Some("GOOD-CODE"));
        assert_eq!(key_id, out.key_id);
        assert_eq!(load_config(dir.path()).unwrap().vault_id.as_deref(), Some(out.vault_id.as_str()));
    }

    #[tokio::test]
    async fn the_vault_id_is_a_uuidv7_the_hub_will_accept() {
        let _env = insecure_ws_env();
        let hub = fake_hub_happy_path(HubVaults::new()).await;
        let dir = tempfile::tempdir().unwrap();

        let out = join(dir.path(), &hub.ws_url(), "GOOD-CODE", Path::new("/v"), &mut Yes::default())
            .await
            .unwrap();

        let parsed = uuid::Uuid::parse_str(&out.vault_id).unwrap();
        assert_eq!(parsed.get_version_num(), 7);
        // The hub validates vault_id as non-empty, <= 64 chars, ascii
        // lowercase/digit/`_`/`-`. A hyphenated lowercase UUID passes; an
        // uppercase or braced rendering would be rejected on arrival.
        assert!(out.vault_id.len() <= 64);
        assert!(out.vault_id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
            "{}", out.vault_id);
    }

    /// One switch decides this, and the control is the same endpoint with the
    /// switch thrown. Without it a refusal could be a join that fails for any
    /// endpoint at all; with it, `ws://127.0.0.1:1` reaches the socket and
    /// dies there, so what the first half measured was the scheme rule.
    ///
    /// There is no host allowlist to test either side of any more: loopback
    /// and tailnet addresses used to be exempt here and died at the channel
    /// binding instead, which had no exemption for them.
    #[tokio::test]
    async fn refuses_a_plain_ws_endpoint_unless_the_escape_hatch_is_set() {
        let _guard = test_hub::env_lock();
        test_hub::force_encrypted_seed_backend();
        std::env::remove_var("LL_ALLOW_INSECURE_WS");

        let dir = tempfile::tempdir().unwrap();
        let err = join(dir.path(), "ws://insecure.example", "C", Path::new("/v"), &mut Yes::default())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("wss://"), "{err}");
        let loopback = join(dir.path(), "ws://127.0.0.1:1", "C", Path::new("/v"), &mut Yes::default())
            .await
            .unwrap_err();
        assert!(loopback.to_string().contains("wss://"),
            "loopback is not exempt: {loopback}");

        std::env::set_var("LL_ALLOW_INSECURE_WS", "1");
        let nowhere = join(dir.path(), "ws://127.0.0.1:1", "C", Path::new("/v"), &mut Yes::default())
            .await
            .unwrap_err();
        std::env::remove_var("LL_ALLOW_INSECURE_WS");
        assert!(!nowhere.to_string().contains("wss://"), "{nowhere}");
    }

    #[tokio::test]
    async fn declining_the_hub_fingerprint_stops_before_anything_is_created() {
        let _env = insecure_ws_env();
        let hub = fake_hub_happy_path(HubVaults::new()).await;
        let dir = tempfile::tempdir().unwrap();
        let mut confirm = DeclineAt::new(Step::Fingerprint);

        let err = join(dir.path(), &hub.ws_url(), "GOOD-CODE", Path::new("/v"), &mut confirm)
            .await
            .unwrap_err();

        assert!(err.to_string().contains("fingerprint not confirmed"), "{err}");
        assert!(hub.last_hello().is_none(),
            "the invite must not reach an unconfirmed hub — it is redeemed on the \
             hello, so sending it burns it");
        assert!(!dir.path().join("federation").exists(),
            "declining before the identity exists must not create one");
    }

    #[tokio::test]
    async fn declining_the_recovery_phrase_aborts_the_join() {
        let _env = insecure_ws_env();
        let hub = fake_hub_happy_path(HubVaults::new()).await;
        let dir = tempfile::tempdir().unwrap();
        let mut confirm = DeclineAt::new(Step::Phrase);

        let err = join(dir.path(), &hub.ws_url(), "GOOD-CODE", Path::new("/v"), &mut confirm)
            .await
            .unwrap_err();

        assert_eq!(confirm.reached, Some(Step::Phrase),
            "the phrase must actually be put to the user; a join that never asks \
             cannot be stopped here");
        assert!(err.to_string().contains("recovery phrase not confirmed"), "{err}");
        assert!(hub.last_hello().is_none(), "nothing should have been sent to the hub");
        assert!(!config::config_path(dir.path()).exists());
    }

    #[tokio::test]
    async fn refuses_to_join_a_second_time_over_a_working_config() {
        let _env = insecure_ws_env();
        let hub = fake_hub_happy_path(HubVaults::new()).await;
        let dir = tempfile::tempdir().unwrap();

        join(dir.path(), &hub.ws_url(), "GOOD-CODE", Path::new("/v"), &mut Yes::default())
            .await
            .unwrap();
        let first = std::fs::read_to_string(config::config_path(dir.path())).unwrap();

        let err = join(dir.path(), &hub.ws_url(), "ANOTHER", Path::new("/v"), &mut Yes::default())
            .await
            .unwrap_err();

        assert!(err.to_string().contains("already exists"), "{err}");
        assert_eq!(std::fs::read_to_string(config::config_path(dir.path())).unwrap(), first,
            "a refused re-join must not have touched the config it refused to replace");
    }

    #[tokio::test]
    async fn refuses_a_hub_announcing_a_protocol_this_client_does_not_speak() {
        let _env = insecure_ws_env();
        let hub = test_hub::spawn_well_known_only(&hub_key_id_str(), PROTOCOL_VERSION + 1).await;
        let dir = tempfile::tempdir().unwrap();
        let mut confirm = Yes::default();

        let err = join(dir.path(), &hub.ws_url(), "GOOD-CODE", Path::new("/v"), &mut confirm)
            .await
            .unwrap_err();

        assert!(err.to_string().contains("protocol"), "{err}");
        assert!(confirm.fingerprint.is_none(),
            "a version this client cannot speak is settled before the user is asked \
             to compare anything");
    }

    /// The seed is the one thing a failed join deliberately leaves behind. It
    /// is the vault's identity, not residue: churning it on every failed
    /// attempt would hand the hub a different key each retry.
    #[tokio::test]
    async fn a_failed_join_keeps_the_identity_so_a_retry_is_the_same_key() {
        let _env = insecure_ws_env();
        let dir = tempfile::tempdir().unwrap();

        let rejecting = fake_hub_that_rejects_the_invite().await;
        assert!(join(dir.path(), &rejecting.ws_url(), "BAD", Path::new("/v"), &mut Yes::default())
            .await
            .is_err());
        let (_, _, first_key) = hello_of(&rejecting).expect("hub saw a client-hello");

        let good = fake_hub_happy_path(HubVaults::new()).await;
        let out = join(dir.path(), &good.ws_url(), "GOOD-CODE", Path::new("/v"), &mut Yes::default())
            .await
            .unwrap();

        assert_eq!(out.key_id, first_key,
            "the retry must present the identity the first attempt created");
    }

    /// A plugin data root that already holds a joined vault: the shape every
    /// second-vault case starts from.
    fn plugin_data_with_a_root_vault(pd: &Path) {
        std::fs::create_dir_all(pd.join("federation")).unwrap();
        std::fs::write(
            config::config_path(pd),
            serde_json::json!({
                "identity": {"displayName": "brain", "pubkey": "ed25519:AAAA"},
                "visibility": {"default": "private", "rules": []},
                "hub": {"endpoint": "wss://h.example/ws", "key_id": "zAbc"},
                "vault_path": "/home/r/brain"
            })
            .to_string(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn the_root_vault_joins_with_no_registry_entry_because_its_config_is_the_entry() {
        let _env = insecure_ws_env();
        let hub = fake_hub_happy_path(HubVaults::new()).await;
        // A plugin data root is a directory whose parent holds neither a
        // registry nor a config — nothing has registered anything yet.
        let home = tempfile::tempdir().unwrap();
        let plugin_data = home.path().join("plugin-data");
        std::fs::create_dir_all(&plugin_data).unwrap();

        join(&plugin_data, &hub.ws_url(), "GOOD-CODE", Path::new("/home/r/brain"), &mut Yes::default())
            .await
            .unwrap();

        assert_eq!(
            registry::load(&plugin_data).unwrap().len(),
            1,
            "writing config.json with a vault_path is what registers the root vault; \
             registry::load reads it directly and creates no vaults.json"
        );
    }

    #[tokio::test]
    async fn joins_a_config_dir_a_vault_profile_already_names() {
        let _env = insecure_ws_env();
        let hub = fake_hub_happy_path(HubVaults::new()).await;
        let pd = tempfile::tempdir().unwrap();
        plugin_data_with_a_root_vault(pd.path());
        let work = pd.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        registry::add(pd.path(), registry::VaultProfile {
            id: "work".into(),
            config_dir: work.clone(),
            vault_path: "/home/r/work-vault".into(),
        })
        .unwrap();

        join(&work, &hub.ws_url(), "GOOD-CODE", Path::new("/home/r/work-vault"), &mut Yes::default())
            .await
            .unwrap();

        assert!(config::config_path(&work).exists());
    }

    #[tokio::test]
    async fn refuses_a_config_dir_the_registry_does_not_name() {
        let _env = insecure_ws_env();
        let hub = fake_hub_happy_path(HubVaults::new()).await;
        let pd = tempfile::tempdir().unwrap();
        plugin_data_with_a_root_vault(pd.path());
        registry::add(pd.path(), registry::VaultProfile {
            id: "work".into(),
            config_dir: pd.path().join("work"),
            vault_path: "/home/r/work-vault".into(),
        })
        .unwrap();
        let unregistered = pd.path().join("side-project");

        let err = join(&unregistered, &hub.ws_url(), "GOOD-CODE", Path::new("/home/r/side"), &mut Yes::default())
            .await
            .unwrap_err();

        assert!(err.to_string().contains("ll vault add"),
            "the operator has to be told the command that fixes it: {err}");
        assert!(hub.last_hello().is_none(), "nothing should have reached the hub");
        assert!(!config::config_path(&unregistered).exists());
    }

    /// The exact scenario: a second vault dir under a plugin data root whose
    /// only marker is the first vault's config. No registry exists yet, so
    /// there is nothing that could name this directory.
    #[tokio::test]
    async fn refuses_a_second_vault_dir_when_no_registry_exists_at_all() {
        let _env = insecure_ws_env();
        let hub = fake_hub_happy_path(HubVaults::new()).await;
        let pd = tempfile::tempdir().unwrap();
        plugin_data_with_a_root_vault(pd.path());
        let work = pd.path().join("work");

        let err = join(&work, &hub.ws_url(), "GOOD-CODE", Path::new("/home/r/work-vault"), &mut Yes::default())
            .await
            .unwrap_err();

        assert!(err.to_string().contains("ll vault add"), "{err}");
        assert!(!config::config_path(&work).exists());
    }

    #[test]
    fn the_display_name_is_the_vault_directory_reduced_to_safe_characters() {
        assert_eq!(display_name_for(Path::new("/home/r/brain")), "brain");
        assert_eq!(display_name_for(Path::new("/home/r/my vault!")), "myvault");
        assert_eq!(display_name_for(Path::new("/")), "vault");
    }
}
