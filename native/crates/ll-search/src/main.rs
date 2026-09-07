use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "ll-search", version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Index {
        vault_path: String,
        db_path: String,
        #[arg(long)]
        force: bool,
        #[arg(long)]
        sync: bool,
        #[arg(long)]
        config_dir: Option<String>,
    },
    Query {
        db_path: String,
        text: String,
        #[arg(long, default_value_t = 10)]
        top: usize,
        #[arg(long)]
        config_dir: Option<String>,
        #[arg(long, help = "Vault this query runs against; falls back to $VAULT_PATH. \
                             Resolves which registered vault profile scopes federation lookups.")]
        vault_path: Option<String>,
        #[arg(long, help = "Widen federation lookups to every registered vault, not just this one")]
        all: bool,
        #[arg(long, help = "Recency decay half-life in days")]
        recency: Option<f64>,
        #[arg(long, help = "Only notes after this unix timestamp (seconds)")]
        after: Option<f64>,
        #[arg(long, help = "Only notes before this unix timestamp (seconds)")]
        before: Option<f64>,
        #[arg(long, help = "Only notes from this session ID")]
        session: Option<i64>,
        #[arg(long, help = "Boost notes from this project tag's active period")]
        project: Option<String>,
        #[arg(long, default_value_t = 0.15, help = "Minimum score threshold (results below are filtered)")]
        threshold: f64,
    },
    Similar {
        db_path: String,
        note_path: String,
        #[arg(long, default_value_t = 10)]
        top: usize,
    },
    Cluster {
        db_path: String,
        #[arg(long, default_value_t = 0.85)]
        threshold: f32,
    },
    Discriminate {
        db_path: String,
        #[arg(long, default_value_t = 0.85)]
        threshold: f32,
        paths: Vec<String>,
    },
    ReflectScan {
        db_path: String,
        queries: Vec<String>,
        #[arg(long, default_value_t = 5)]
        top: usize,
        #[arg(long, default_value_t = 20)]
        candidates: usize,
        #[arg(long, default_value_t = 0.85)]
        threshold: f32,
        #[arg(long)]
        config_dir: Option<String>,
    },
    Embed {
        text: String,
    },
    Rerank {
        db_path: String,
        query: String,
        #[arg(long, default_value_t = 10)]
        top: usize,
        #[arg(long, default_value_t = 20)]
        candidates: usize,
        #[arg(long)]
        config_dir: Option<String>,
    },
    Version,
    /// Federation status: what the last sync cycle did, and whether the hub
    /// holds an index for this vault. Reads local files only.
    Status {
        #[arg(long)]
        config_dir: Option<String>,
    },
    /// Index health for the local search index, as JSON. Was `ll status`
    /// before v5 gave that name to federation status.
    IndexStatus {
        db_path: String,
        vault_path: String,
    },
    Tags {
        db_path: String,
        #[arg(long, default_value_t = 3, help = "Minimum notes per tag")]
        min_count: usize,
    },
    Intentions {
        db_path: String,
        context: Option<String>,
    },
    Sessions {
        db_path: String,
        #[arg(long, default_value_t = 2, help = "Minimum notes per session")]
        min_notes: usize,
    },
    LinkStats {
        db_path: String,
        #[arg(long)]
        folder: Option<String>,
        #[arg(long)]
        orphans: bool,
    },
    /// One-shot: make today's glob-derived `public` set explicit in frontmatter.
    VisibilityBackfill {
        vault_path: String,
        #[arg(long)]
        config_dir: Option<String>,
        /// Report what would change without writing anything.
        #[arg(long)]
        dry_run: bool,
    },
    Export {
        db_path: String,
        output: String,
        vault_path: String,
        #[arg(long)]
        config_dir: Option<String>,
    },
    Sync {
        db_path: String,
        vault_path: String,
        #[arg(long)]
        config_dir: Option<String>,
        /// Override the hub endpoint URL. Falls back to LL_HUB_ENDPOINT env
        /// var if the flag is absent.
        #[arg(long)]
        hub_endpoint: Option<String>,
    },
    /// Enroll this vault on a hub with an invite code. Writes nothing unless
    /// the hub proves its identity and admits ours.
    Join {
        /// Hub endpoint, e.g. wss://hub.example.
        hub: String,
        /// Invite code, from an existing member.
        invite: String,
        vault_path: String,
        #[arg(long)]
        config_dir: Option<String>,
    },
    Identity {
        #[arg(long)]
        config_dir: Option<String>,
    },
    /// Put the identity a 24-word recovery phrase names onto this machine.
    /// The phrase decides which key that is — this machine's own only if this
    /// is the machine `ll-search join` printed it on.
    Recover {
        /// The 24 words, quoted as a single argument.
        phrase: String,
        /// Replace an identity already on this machine with a different one.
        /// Without it that is refused: the old key's grants would survive it,
        /// signed and unreachable.
        #[arg(long)]
        force: bool,
        #[arg(long)]
        config_dir: Option<String>,
    },
    MigrateSeed {
        #[arg(long)]
        config_dir: Option<String>,
        /// Reverse a completed migration: restore plaintext seed from secure backend.
        #[arg(long)]
        rollback: bool,
    },
    Watch {
        vault_path: String,
        db_path: String,
        #[arg(long, default_value_t = 300)]
        sync_interval: u64,
        #[arg(long)]
        config_dir: Option<String>,
        #[arg(long)]
        pid_file: Option<String>,
        #[arg(long)]
        librarian_script: Option<String>,
    },
    Migrate {
        db_path: String,
        #[arg(long)]
        model: String,
        #[arg(long)]
        drop_old: bool,
    },
    Benchmark {
        db_path: String,
        #[arg(long)]
        model_a: String,
        #[arg(long)]
        model_b: String,
        queries: Vec<String>,
    },
    TunePrf {
        db_path: String,
        queries: Vec<String>,
    },
    EvalPrf {
        db_path: String,
        #[arg(long, default_value_t = 2)]
        min_links: usize,
    },
    LaneDiag {
        db_path: String,
        /// JSON array of [set, gold_path, query_text] triples.
        probes: String,
    },
    TuneWeights {
        db_path: String,
        #[arg(long, default_value_t = 2)]
        min_links: usize,
        #[arg(long)]
        limit: Option<usize>,
    },
    EvalFunnel {
        db_path: String,
        #[arg(long, default_value_t = 2)]
        min_links: usize,
        #[arg(long, help = "Cap the number of queries (random sample)")]
        limit: Option<usize>,
    },
    Vault {
        #[command(subcommand)]
        command: VaultCommand,
    },
    /// Add a machine to this identity. Four doors, one grant.
    Link {
        #[command(subcommand)]
        command: LinkCommand,
    },

}

#[derive(Subcommand)]
enum LinkCommand {
    /// On the new machine: show its pairing code and QR, over no network at
    /// all. Doors 2 and 3 start here.
    Code {
        #[arg(long)]
        config_dir: Option<String>,
    },
    /// On the new machine: the same pairing code, plus the hub this identity
    /// will reach once an established machine has admitted it. Door 1.
    Request {
        /// Hub endpoint, e.g. wss://hub.example.
        hub: String,
        vault_path: String,
        #[arg(long)]
        config_dir: Option<String>,
    },
    /// On an established machine: admit the key a pairing code names.
    /// Lodges the grant with the hub unless --offline.
    Approve {
        /// The pairing code the new machine is showing.
        code: String,
        /// Sign the grant and print it instead of lodging it, for a machine
        /// with no network path to this one.
        #[arg(long)]
        offline: bool,
        #[arg(long)]
        config_dir: Option<String>,
    },
    /// On the new machine: take a grant handed over offline. Door 3.
    Accept {
        /// The grant blob `ll link approve --offline` printed.
        grant: String,
        #[arg(long)]
        config_dir: Option<String>,
    },
    /// The machines this one is linked to, and which halves exist. A row
    /// reading `outbound` is one this machine admitted and has never seen
    /// answer — an approval nobody picked up looks exactly like that, and
    /// `link revoke` is how it is taken back.
    List {
        #[arg(long)]
        config_dir: Option<String>,
    },
    /// Withdraw the link this machine issued to another machine.
    ///
    /// Only the half this machine signed. The grant the other machine issued
    /// to this one is its own statement about its own key, and only that
    /// machine can withdraw it.
    ///
    /// This deletes no cached data. A link covers every vault its issuer
    /// owns, which names no single directory under `federation/data/peers/`
    /// to remove, so nothing there is touched.
    Revoke {
        /// The key id of the machine to cut off, as `link list` prints it.
        key_id: String,
        #[arg(long)]
        config_dir: Option<String>,
    },
}

#[derive(Subcommand)]
enum VaultCommand {
    /// Register a vault under a config dir isolated from every other vault.
    Add {
        vault_path: String,
        id: String,
        #[arg(long)]
        config_dir: Option<String>,
    },
    /// List registered vaults: id, vault path, config dir, federation status.
    List {
        #[arg(long)]
        config_dir: Option<String>,
    },
}

fn parse_model(s: &str) -> ll_search::model::KnownModel {
    match s {
        "bge-small" | "bge" | "bge-small-en-v1.5" => ll_search::model::KnownModel::BgeSmallEnV15,
        other => {
            eprintln!("Unknown model: '{}'. Available: bge-small", other);
            std::process::exit(1);
        }
    }
}

fn init_embedding() {
    ll_search::embed::init_provider(&ll_search::model::KnownModel::BgeSmallEnV15);
}

fn out<T: serde::Serialize>(data: &T) {
    ll_search::app::emit(data, true).expect("emit");
}

/// What the joining machine puts on its screen. The six words go to stderr
/// beside the code because they are read aloud, not piped anywhere.
fn show_pending(pending: &ll_search::sync::link::PendingLink) {
    eprintln!();
    match pending.qr() {
        Ok(qr) => eprintln!("{qr}"),
        Err(e) => eprintln!("(no QR: {e})"),
    }
    eprintln!("  this machine: {}", pending.fingerprint);
    eprintln!();
    eprintln!("Type or scan the code below on a machine you already use, then check");
    eprintln!("that the six words it shows are the six words above.");
    eprintln!();
    println!("{}", pending.code);
}

/// What `ll link revoke` tells the person — and the half that matters is
/// what it refuses to say.
///
/// Spec:334 makes a revocation remove `federation/data/peers/<vault_id>/`,
/// and this command removes nothing: a link covers every vault its issuer
/// owns, so it names no directory to take (`sync::grants::names` is where
/// that argument lives). A line reading "removed" here would be a claim about
/// somebody's notes coming back, so the report states what did not happen as
/// plainly as what did, and every branch of it does.
fn revoke_report(
    done: &ll_search::sync::link::Revoked,
    other: &ll_search::sync::key_id::KeyId,
) -> String {
    let mut out = format!(
        "Withdrew {} link grant(s) issued to {}. The hub acknowledged it and stops \
         authorising that key.\n",
        done.grant_ids.len(),
        other.as_str(),
    );
    if done.inbound_remains {
        out.push_str(&format!(
            "The link {} issued to THIS machine still stands. It is that machine's own \
             statement and only it can withdraw it.\n",
            other.as_str(),
        ));
    }
    out.push_str(
        "Nothing was deleted. A link covers every vault its issuer owns, so it names no \
         cached directory to take, and federation/data/peers/ is exactly as it was. Data \
         that machine already fetched is not recalled either — it stops being served, and \
         it drops what the withdrawal names on its next sync.\n",
    );
    out
}

/// What a completed [`recover`] did. `replaced` is `Some` only when a
/// *different* identity was on this machine and `--force` authorised losing
/// it; it names the key that is now gone, because "an identity was replaced"
/// with no way to say which one is not a report anybody can act on.
///
/// Every field is public-half only, so unlike `JoinOutcome` this can derive
/// `Debug` without putting a secret in a log line.
#[derive(Debug)]
struct RecoverOutcome {
    key_id: String,
    backend: ll_search::sync::seed_store::SeedBackend,
    replaced: Option<String>,
}

/// Put the signing identity a 24-word recovery phrase names onto this machine.
///
/// **Not "this machine's identity".** The phrase names one key and this makes
/// that key the one this machine signs with, whatever key it held before. Run
/// on a second machine it hands over the FIRST machine's identity, which is a
/// real use — the machine that held it is gone — and is why the reports here
/// name keys rather than saying "the identity".
///
/// The guard is `--force`, and what it guards is the *loss*, not the write: a
/// recovery that would put a different key here orphans every grant naming the
/// old one — they stay signed, valid and unreachable, while the machine still
/// looks enrolled.
///
/// Which is why recovering the identity already here needs no `--force`.
/// Nothing is replaced, so there is nothing to authorise. That is not a
/// special case in the code either — `replaced` is the identity this would
/// *lose*, and an identical seed simply does not produce one. Refusing it
/// would make checking that the phrase in the drawer is the right one the
/// case that trains a user to reach for `--force`, which is the one habit
/// this guard cannot survive.
fn recover(
    config_dir: &std::path::Path,
    phrase: &str,
    force: bool,
) -> anyhow::Result<RecoverOutcome> {
    use ed25519_dalek::SigningKey;
    use ll_search::sync::{key_id::KeyId, seed_store, words};

    // Before anything on disk is touched: a phrase that does not decode must
    // cost the caller nothing, `--force` or not.
    let seed = zeroize::Zeroizing::new(words::seed_from_phrase(phrase)?);
    let key_id = KeyId::from_pubkey(&SigningKey::from_bytes(&seed).verifying_key());

    let existing = seed_store::load_only(config_dir)?;
    // Not `replaced.is_none()`. A machine with no readable seed replaces
    // nothing, and it is also a machine that cannot show it wrote the listing
    // sitting next to it — which is `ReadAuthority::load`'s rule, that no
    // identity is no authority rather than an unchanged one.
    let same_identity = existing.as_ref().is_some_and(|r| r.signing_key.to_bytes() == *seed);
    let replaced = existing
        .filter(|r| r.signing_key.to_bytes() != *seed)
        .map(|r| KeyId::from_pubkey(&r.signing_key.verifying_key()).as_str().to_string());

    if let (Some(old), false) = (&replaced, force) {
        anyhow::bail!(
            "{} already holds a different identity ({old}); recovering over it would orphan \
             every grant that names it. Re-run with --force if that is what you mean.",
            config_dir.display(),
        );
    }

    // Before the seed moves, not after. `readable-vaults.json` is the hub's
    // answer about what some earlier key was allowed to read, and it survives
    // a recovery that makes it meaningless — so a reader that trusts it now
    // serves that key's caches under the new one. It stays only when the
    // identity now installed is the one that earned it.
    //
    // Deleting it rather than teaching each reader to check whose answer it
    // was: absent already means no authority everywhere it is read, in every
    // language, including readers nobody has written yet. `ll sync` writes the
    // new key's answer on the next cycle.
    //
    // The order is the recoverable one. Failing here leaves the OLD identity
    // with no listing, which one sync fixes. The other order leaves the NEW
    // identity holding the old key's answer, which nothing fixes because
    // nothing afterwards knows it is wrong.
    if !same_identity {
        use anyhow::Context as _;
        let listed = ll_search::sync::config::readable_vaults_path(config_dir);
        match std::fs::remove_file(&listed) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(e).with_context(|| {
                    format!("could not drop {}, which names what the identity \
                             being replaced was allowed to read", listed.display())
                })
            }
        }
    }

    let backend = seed_store::store_seed(config_dir, &seed)?;
    Ok(RecoverOutcome { key_id: key_id.as_str().to_string(), backend, replaced })
}

/// Wall-clock seconds, for the one caller in this file that needs to hand a
/// point in time to the library. A clock before 1970 reads as 1970 rather
/// than panicking: this is on the query path, and every grant expiry then
/// compares as lapsed, which is the fail-closed direction.
fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn build_app_state(db_path: &str, config_dir: Option<String>) -> ll_search::app::AppState {
    ll_search::app::AppState::from_db(db_path, config_dir).expect("failed to build AppState")
}

/// Resolve which vault(s) a query's federation lookups may read, then collect
/// their peer indexes.
///
/// `config_dir` here is the plugin_data root (the registry's home), matching
/// `ll vault add`/`ll vault list`. A legacy single-vault install has no
/// registry at all, so this never touches it unless a federation config or a
/// `vaults.json` already exists there — reading is never a write, and a
/// non-federated install pays no registry cost.
///
/// The one branch that matters is whether `vaults.json` exists:
///
/// - It doesn't → there is by definition exactly one vault, and its config
///   dir is `plugin_data` itself. No `vault_path` is needed to know that, and
///   none is required — this is the zero-migration single-vault case working
///   correctly, not a fallback rescuing an error.
/// - It does → genuinely multi-vault, so guessing which one the caller meant
///   is exactly the case where being wrong leaks across vaults. Resolution
///   failures here fail loud (panic with an actionable message) rather than
///   widening the search — scoping must never fail open.
fn resolve_peers(
    conn: &rusqlite::Connection,
    config_dir: Option<String>,
    vault_path: Option<String>,
    all: bool,
) -> Vec<(String, rusqlite::Connection)> {
    let plugin_data = ll_search::sync::config::resolve_config_dir_opt(config_dir);
    let has_registry = plugin_data.join("vaults.json").exists();
    let federated = has_registry || plugin_data.join("federation").join("config.json").exists();
    if !federated {
        return Vec::new();
    }
    let model_id: String = match conn.query_row(
        "SELECT value FROM meta WHERE key = 'model_id'",
        [],
        |r| r.get(0),
    ) {
        Ok(id) => id,
        Err(_) => return Vec::new(),
    };

    let scope = if !has_registry {
        ll_search::search::QueryScope { config_dirs: vec![plugin_data.clone()] }
    } else if all {
        ll_search::search::query_scope(&plugin_data, std::path::Path::new(""), true)
            .expect("failed to load the vault registry for --all")
    } else {
        let vault = vault_path
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::var("VAULT_PATH").ok().map(std::path::PathBuf::from))
            .expect(
                "multiple vaults are registered; set $VAULT_PATH (or pass --vault-path, \
                 if this is `ll query`) to say which one this query scopes to",
            );
        ll_search::search::query_scope(&plugin_data, &vault, false)
            .unwrap_or_else(|e| panic!("failed to resolve vault scope: {e}"))
    };

    // The reader's grant check is a point in time, and `unix_now` is where
    // this process gets one. Threaded rather than read inside the search path
    // for the same reason `render_status` takes it: an expiry boundary that
    // cannot be moved cannot be tested from both sides.
    ll_search::search::discover_peer_dbs_for(&scope, &model_id, unix_now())
}

fn vault_add(plugin_data: &std::path::Path, vault_path: &std::path::Path, id: &str) -> anyhow::Result<()> {
    if ll_search::sync::registry::resolve_by_vault_path(plugin_data, vault_path).is_ok() {
        anyhow::bail!("{} is already registered", vault_path.display());
    }
    let config_dir = plugin_data.join(id);
    std::fs::create_dir_all(config_dir.join("federation"))?;
    ll_search::sync::registry::add(plugin_data, ll_search::sync::registry::VaultProfile {
        id: id.to_string(),
        config_dir,
        vault_path: vault_path.to_path_buf(),
    })?;
    eprintln!("Registered vault '{id}'. Run `ll join` in it to create its identity.");
    Ok(())
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let cli = Cli::parse();
    match cli.command {
        Commands::Version => {
            println!("{}", env!("CARGO_PKG_VERSION"));
        }
        Commands::Index { vault_path, db_path, force, sync, config_dir, .. } => {
            init_embedding();
            let conn = ll_search::db::open_or_create_db(&db_path).expect("failed to open database");
            let result = ll_search::db::reindex(&conn, &vault_path, force).expect("reindex failed");
            out(&result);
            if sync {
                let config_dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
                if let Ok(config) = ll_search::sync::config::load_config(&config_dir) {
                    match ll_search::sync::client::sync_all_async(
                        std::path::Path::new(&db_path),
                        std::path::Path::new(&vault_path),
                        &config_dir,
                        &config,
                    ).await {
                        Ok(sync_result) => eprintln!("Sync: uploaded {} notes, fetched {} vaults",
                            sync_result.uploaded_notes, sync_result.fetched.len()),
                        Err(e) => eprintln!("Sync failed: {e}"),
                    }
                }
            }
        }
        Commands::Query { db_path, text, top, config_dir, vault_path, all, recency, after, before, session, project, threshold } => {
            let conn = ll_search::db::open_db(&db_path).expect("failed to open database");
            init_embedding();
            let app = build_app_state(&db_path, config_dir.clone());
            let ctx = app.ensure_search_context(&conn);
            let temporal = ll_search::search::TemporalParams {
                recency_days: recency,
                after,
                before,
                session_id: session,
                project_tag: project,
            };
            let peers = resolve_peers(&conn, config_dir, vault_path, all);
            let results = if peers.is_empty() {
                ll_search::search::hybrid_query_with_ctx(&ctx, &conn, &text, top, &temporal)
            } else {
                ll_search::search::hybrid_query_federated_with_ctx(&ctx, &conn, &text, top, &peers, &temporal)
            };
            let response = ll_search::search::build_query_response(text, results, &conn, threshold);
            out(&response);
        }
        Commands::Similar { db_path, note_path, top } => {
            let conn = ll_search::db::open_db(&db_path).expect("failed to open database");
            init_embedding();
            let store = ll_search::search::store::load_store(&conn);
            let results = ll_search::search::similar_notes(&conn, &note_path, top, &store);
            out(&results);
        }
        Commands::Cluster { db_path, threshold } => {
            let conn = ll_search::db::open_db(&db_path).expect("failed to open database");
            init_embedding();
            let store = ll_search::search::store::load_store(&conn);
            let results = ll_search::search::cluster_notes(&conn, threshold, &store);
            out(&results);
        }
        Commands::Discriminate { db_path, threshold, paths } => {
            let conn = ll_search::db::open_db(&db_path).expect("failed to open database");
            init_embedding();
            let store = ll_search::search::store::load_store(&conn);
            let results = ll_search::search::discriminate_pairs(&conn, &paths, threshold, &store);
            out(&results);
        }
        Commands::ReflectScan { db_path, queries, top, candidates, threshold, config_dir } => {
            let conn = ll_search::db::open_db(&db_path).expect("failed to open database");
            init_embedding();
            let store = ll_search::search::store::load_store(&conn);
            let peers = resolve_peers(&conn, config_dir, None, false);
            let result = if peers.is_empty() {
                ll_search::search::reflect_scan(&conn, &queries, top, candidates, threshold, &store)
            } else {
                ll_search::search::reflect_scan_federated(&conn, &queries, top, candidates, threshold, &peers, &store)
            };
            out(&result);
        }
        Commands::Embed { text } => {
            init_embedding();
            let vec = ll_search::embed::embed_query(&text);
            out(&vec);
        }
        Commands::Status { config_dir } => {
            let config_dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock is before 1970")
                .as_secs() as i64;
            let text = ll_search::sync::status::render_status(&config_dir, now)
                .expect("failed to read federation status");
            print!("{text}");
        }
        Commands::IndexStatus { db_path, vault_path } => {
            let conn = ll_search::db::open_db(&db_path).expect("failed to open database");
            let status = ll_search::db::get_status(&conn, &vault_path);
            out(&status);
        }
        Commands::Tags { db_path, min_count } => {
            let conn = ll_search::db::open_db(&db_path).expect("failed to open database");
            let tags = ll_search::db::list_tags(&conn, min_count);
            out(&tags);
        }
        Commands::Intentions { db_path, context } => {
            let conn = ll_search::db::open_db(&db_path).expect("failed to open database");
            match context {
                Some(ctx) => out(&ll_search::db::list_intentions_for_context(&conn, &ctx)),
                None => out(&ll_search::db::list_intentions_summary(&conn)),
            }
        }
        Commands::Sessions { db_path, min_notes } => {
            let conn = ll_search::db::open_db(&db_path).expect("failed to open database");
            let sessions = ll_search::db::list_sessions(&conn, min_notes);
            out(&sessions);
        }
        Commands::LinkStats { db_path, folder, orphans } => {
            let conn = ll_search::db::open_db(&db_path).expect("failed to open database");
            let result = ll_search::db::link_stats(&conn, folder.as_deref(), orphans);
            out(&result);
        }
        Commands::VisibilityBackfill { vault_path, config_dir, dry_run } => {
            let config_dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
            let config = ll_search::sync::config::load_config(&config_dir)
                .expect("failed to load federation config");
            let report = ll_search::sync::backfill::backfill_public(
                std::path::Path::new(&vault_path),
                &config,
                dry_run,
            )
            .expect("backfill failed");
            eprintln!(
                "{} {} of {} scanned ({} already explicit)",
                if dry_run { "Would write" } else { "Wrote" },
                report.written,
                report.scanned,
                report.already_explicit,
            );
        }
        Commands::Export { db_path, output, vault_path, config_dir } => {
            let config_dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
            let config = ll_search::sync::config::load_config(&config_dir)
                .expect("failed to load federation config");
            let result = ll_search::sync::export::export_index(
                std::path::Path::new(&db_path),
                std::path::Path::new(&vault_path),
                std::path::Path::new(&output),
                &config,
            )
            .expect("export failed");
            out(&result);
        }
        Commands::Sync { db_path, vault_path, config_dir, hub_endpoint } => {
            let hub_override = hub_endpoint
                .or_else(|| std::env::var("LL_HUB_ENDPOINT").ok());
            let config_dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
            let mut config = ll_search::sync::config::load_config(&config_dir)
                .expect("failed to load federation config");
            if let Some(endpoint) = hub_override {
                config.hub.endpoint = endpoint;
            }
            config.validate().expect("invalid federation config");
            init_embedding();
            let result = ll_search::sync::client::sync_all_async(
                std::path::Path::new(&db_path),
                std::path::Path::new(&vault_path),
                &config_dir,
                &config,
            )
            .await
            .expect("sync failed");
            out(&result);
        }
        Commands::Join { hub, invite, vault_path, config_dir } => {
            let config_dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
            let outcome = ll_search::sync::join::join(
                &config_dir,
                &hub,
                &invite,
                std::path::Path::new(&vault_path),
                &mut ll_search::sync::join::TtyConfirm,
            )
            .await;
            match outcome {
                Ok(o) => {
                    eprintln!("Joined. Run `ll-search sync` to upload this vault's index.");
                    // No recovery_phrase here. TtyConfirm already showed it once;
                    // putting it on stdout would put it in every log and pipe that
                    // captures this command's output.
                    out(&serde_json::json!({
                        "key_id": o.key_id,
                        "vault_id": o.vault_id,
                        "hub_key_id": o.hub_key_id,
                        "hub_fingerprint": o.hub_fingerprint,
                        "recovery_key_id": o.recovery_key_id,
                    }));
                }
                Err(e) => {
                    eprintln!("join failed: {e:#}");
                    std::process::exit(1);
                }
            }
        }
        Commands::Identity { config_dir } => {
            let config_dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
            let result = ll_search::sync::seed_store::load_or_create(&config_dir)
                .expect("failed to load or create seed");
            out(&serde_json::json!({
                "pubkey_b64": ll_search::sync::auth::pubkey_b64(&result.signing_key),
                "backend": result.backend.to_string(),
                "created": result.created,
            }));
        }
        Commands::Recover { phrase, force, config_dir } => {
            let dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
            match recover(&dir, &phrase, force) {
                Ok(o) => {
                    match &o.replaced {
                        Some(old) => eprintln!(
                            "Replaced {old}. Every grant naming it is now inert — the peers \
                             that hold them have to be re-linked.",
                        ),
                        None => eprintln!("Recovered {}.", o.key_id),
                    }
                    out(&serde_json::json!({
                        "key_id": o.key_id,
                        "backend": o.backend.to_string(),
                        "replaced": o.replaced,
                    }));
                }
                Err(e) => {
                    eprintln!("recover failed: {e:#}");
                    std::process::exit(1);
                }
            }
        }
        Commands::MigrateSeed { config_dir, rollback } => {
            let config_dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
            if rollback {
                let result = ll_search::sync::seed_migrate::migrate_rollback(&config_dir)
                    .expect("seed migration rollback failed");
                out(&serde_json::json!({
                    "from": result.from.to_string(),
                    "to": result.to.to_string(),
                    "plaintext_removed": result.plaintext_removed,
                    "already_migrated": result.already_migrated,
                }));
            } else {
                let result = ll_search::sync::seed_migrate::migrate(&config_dir)
                    .expect("seed migration failed");
                out(&serde_json::json!({
                    "from": result.from.to_string(),
                    "to": result.to.to_string(),
                    "plaintext_removed": result.plaintext_removed,
                    "already_migrated": result.already_migrated,
                }));
            }
        }
        Commands::Rerank { db_path, query, top, candidates, config_dir } => {
            let conn = ll_search::db::open_db(&db_path).expect("failed to open database");
            init_embedding();
            let store = ll_search::search::store::load_store(&conn);
            let peers = resolve_peers(&conn, config_dir, None, false);
            let scored = ll_search::rerank::run(&conn, &peers, &query, top, candidates, &store);
            out(&scored);
        }
        Commands::Watch { vault_path, db_path, sync_interval, config_dir, pid_file, librarian_script } => {
            init_embedding();
            let config_dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
            let pid_file = pid_file
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| config_dir.join("watch.pid"));

            if ll_search::sync::watch::is_watch_running(&pid_file) {
                eprintln!("Watch already running (PID file: {})", pid_file.display());
                std::process::exit(1);
            }

            let cfg = ll_search::sync::watch::WatchConfig {
                vault_path: std::path::PathBuf::from(vault_path),
                db_path: std::path::PathBuf::from(db_path),
                config_dir,
                pid_file,
                sync_interval: std::time::Duration::from_secs(sync_interval),
                librarian_script: librarian_script.map(std::path::PathBuf::from),
            };
            ll_search::sync::watch::run_watch_async(cfg).await.expect("watch failed");
        }
        Commands::Migrate { db_path, model, drop_old } => {
            let conn = ll_search::db::open_db(&db_path).expect("failed to open database");
            if drop_old {
                ll_search::db::drop_old_embeddings(&conn);
                eprintln!("Dropped old embeddings table.");
            } else {
                let target = parse_model(&model);
                let provider = ll_search::model::loader::load_provider(&target)
                    .expect("failed to load model");
                let result = ll_search::db::migrate_embeddings(&conn, provider.as_ref());
                out(&result);
            }
        }
        Commands::EvalPrf { db_path, min_links } => {
            let conn = ll_search::db::open_db(&db_path).expect("failed to open database");
            init_embedding();
            let store = ll_search::search::store::load_store(&conn);
            let result = ll_search::search::eval_prf(&conn, &store, min_links);
            out(&result);
        }
        Commands::EvalFunnel { db_path, min_links, limit } => {
            let conn = ll_search::db::open_db(&db_path).expect("failed to open database");
            init_embedding();
            let store = ll_search::search::store::load_store(&conn);
            let result = ll_search::search::eval_funnel(&conn, &store, min_links, limit);
            out(&result);
        }
        Commands::LaneDiag { db_path, probes } => {
            let conn = ll_search::db::open_db(&db_path).expect("failed to open database");
            init_embedding();
            let raw = std::fs::read_to_string(&probes).expect("read probes");
            let triples: Vec<(String, String, String)> =
                serde_json::from_str(&raw).expect("parse probes");
            out(&ll_search::search::lane_diagnostics(&conn, &triples));
        }
        Commands::TuneWeights { db_path, min_links, limit } => {
            let conn = ll_search::db::open_db(&db_path).expect("failed to open database");
            init_embedding();
            let store = ll_search::search::store::load_store(&conn);
            let results = ll_search::search::tune_weights(&conn, &store, min_links, limit);
            println!("{:>6} {:>6} {:>6}   {:>9} {:>9}", "vec", "ppr", "tag", "train", "holdout");
            for (w, train, hold) in results.iter() {
                println!("{:>6.2} {:>6.2} {:>6.2}   {:>9.4} {:>9.4}", w.vec, w.ppr, w.tag, train, hold);
            }
            let dflt = ll_search::search::scoring_defaults();
            if let Some((w, train, hold)) =
                results.iter().find(|(w, _, _)| *w == dflt)
            {
                println!("\nshipped default: ppr {:.2} tag {:.2} -> train {:.4} holdout {:.4}",
                    w.ppr, w.tag, train, hold);
            }
        }
        Commands::TunePrf { db_path, queries } => {
            let conn = ll_search::db::open_db(&db_path).expect("failed to open database");
            init_embedding();
            let store = ll_search::search::store::load_store(&conn);
            let result = ll_search::search::tune_prf(&conn, &queries, &store);
            out(&result);
        }

        Commands::Vault { command } => match command {
            VaultCommand::Add { vault_path, id, config_dir } => {
                let plugin_data = ll_search::sync::config::resolve_config_dir_opt(config_dir);
                vault_add(&plugin_data, std::path::Path::new(&vault_path), &id).expect("vault add failed");
            }
            VaultCommand::List { config_dir } => {
                let plugin_data = ll_search::sync::config::resolve_config_dir_opt(config_dir);
                let profiles = ll_search::sync::registry::load(&plugin_data).expect("failed to load vault registry");
                for p in profiles {
                    let configured = p.config_dir.join("federation").join("config.json").exists();
                    println!(
                        "{}\t{}\t{}\t{}",
                        p.id,
                        p.vault_path.display(),
                        p.config_dir.display(),
                        if configured { "configured" } else { "not configured" },
                    );
                }
            }
        },
        Commands::Link { command } => {
            use ll_search::sync::link;
            let fail = |e: anyhow::Error| -> ! {
                eprintln!("link failed: {e:#}");
                std::process::exit(1);
            };
            match command {
                LinkCommand::Code { config_dir } => {
                    let dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
                    show_pending(&link::pending_offline(&dir).unwrap_or_else(|e| fail(e)));
                }
                LinkCommand::Request { hub, vault_path, config_dir } => {
                    let dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
                    let pending = link::request(
                        &dir,
                        &hub,
                        std::path::Path::new(&vault_path),
                        &mut link::TtyApprove,
                    )
                    .await
                    .unwrap_or_else(|e| fail(e));
                    show_pending(&pending);
                }
                LinkCommand::Approve { code, offline, config_dir } => {
                    let dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
                    if offline {
                        let blob = link::approve_offline(&dir, &code, &mut link::TtyApprove)
                            .unwrap_or_else(|e| fail(e));
                        eprintln!();
                        eprintln!("Give this to the new machine — `ll-search link accept <grant>`:");
                        eprintln!();
                        println!("{blob}");
                    } else {
                        link::approve(&dir, &code, &mut link::TtyApprove)
                            .await
                            .unwrap_or_else(|e| fail(e));
                        eprintln!("Admitted. The new machine collects the grant on its next sync.");
                    }
                }
                LinkCommand::Accept { grant, config_dir } => {
                    let dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
                    link::accept_offline(&dir, &grant).unwrap_or_else(|e| fail(e));
                    eprintln!("Linked. This machine is now one of yours.");
                }
                LinkCommand::List { config_dir } => {
                    let dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
                    out(&link::list(&dir).unwrap_or_else(|e| fail(e)));
                }
                LinkCommand::Revoke { key_id, config_dir } => {
                    let dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
                    let other = ll_search::sync::key_id::KeyId::parse(&key_id)
                        .unwrap_or_else(|e| fail(e.context(
                            "that is not a key id. `ll-search link list` prints the key id of \
                             every machine this one is linked to",
                        )));
                    let done = link::revoke(&dir, &other).await.unwrap_or_else(|e| fail(e));
                    eprint!("{}", revoke_report(&done, &other));
                }
            }
        }
        Commands::Benchmark { db_path, model_a, model_b, queries } => {
            let ma = parse_model(&model_a);
            let mb = parse_model(&model_b);
            let result = ll_search::model::benchmark::run_benchmark(
                std::path::Path::new(&db_path),
                &ma,
                &mb,
                &queries,
            )
            .expect("benchmark failed");
            out(&result);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    /// A connection with just enough `meta` to satisfy resolve_peers' model_id lookup.
    fn conn_with_model(model_id: &str) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO meta (key, value) VALUES ('model_id', '{model_id}');"
        )).unwrap();
        conn
    }

    /// Registers two vault profiles under `plugin_data`, each with its own
    /// (initially peer-less) federation config dir.
    fn two_vault_profiles(plugin_data: &Path) {
        for (id, vault) in [("personal", "/v/personal"), ("work", "/v/work")] {
            let config_dir = plugin_data.join(id);
            std::fs::create_dir_all(config_dir.join("federation")).unwrap();
            ll_search::sync::registry::add(plugin_data, ll_search::sync::registry::VaultProfile {
                id: id.to_string(),
                config_dir,
                vault_path: PathBuf::from(vault),
            }).unwrap();
        }
    }

    /// A peer index on disk, **and the identity, live grant, and hub listing
    /// that make it readable**.
    ///
    /// All four, because `discover_peer_dbs` serves a cache only when the hub
    /// last listed that vault AND a live grant covers it. A fixture that
    /// planted the directory alone would make every assertion below pass or
    /// fail for the wrong reason: the two scoping tests would assert an
    /// absence the read filter already guarantees, and the two that expect a
    /// hit would be asserting against a cache no key was ever entitled to
    /// read.
    fn seed_peer(config_dir: &Path, peer: &str, model_id: &str) {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, SigningKey};
        use ll_search::sync::grant::{self, GrantKind, GrantStatement};
        use ll_search::sync::key_id::KeyId;

        let peer_dir = config_dir.join("federation").join("data").join("peers").join(peer);
        std::fs::create_dir_all(&peer_dir).unwrap();
        let conn = rusqlite::Connection::open(peer_dir.join("index.db")).unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO meta (key, value) VALUES ('model_id', '{model_id}');"
        )).unwrap();
        drop(conn);

        pin_file_backend();
        // Keyed on the directory, so two profiles under one plugin_data get
        // two identities and a grant to one never covers the other's cache.
        let seed: [u8; 32] =
            <sha2::Sha256 as sha2::Digest>::digest(config_dir.to_string_lossy().as_bytes()).into();
        let me = match ll_search::sync::seed_store::load_only(config_dir).unwrap() {
            Some(r) => KeyId::from_pubkey(&r.signing_key.verifying_key()),
            None => {
                ll_search::sync::seed_store::write_encrypted(config_dir, &seed).unwrap();
                KeyId::from_pubkey(&SigningKey::from_bytes(&seed).verifying_key())
            }
        };

        let issuer = SigningKey::from_bytes(&[3u8; 32]);
        let statement = grant::canonical_bytes(&GrantStatement {
            v: 5,
            kind: GrantKind::Follow,
            from: KeyId::from_pubkey(&issuer.verifying_key()),
            to: me.clone(),
            scope: Some(peer.to_string()),
            issued_at: 1,
            expires_at: i64::MAX,
            nonce: format!("{}-{peer}", config_dir.display()),
        });
        let b64 = base64::engine::general_purpose::STANDARD;
        ll_search::sync::grants::apply_grants(config_dir, &[ll_search::sync::protocol_v5::GrantWire {
            statement_b64: b64.encode(&statement),
            signature_b64: b64.encode(issuer.sign(&statement).to_bytes()),
            state: "active".to_string(),
        }]).unwrap();

        let mut listed = ll_search::sync::state::read_readable_vaults(config_dir)
            .unwrap()
            .filter(|l| l.me == me)
            .unwrap_or(ll_search::sync::state::ReadableVaults {
                me, at: 0, vault_ids: Vec::new(),
            });
        if !listed.contains(peer) {
            listed.vault_ids.push(peer.to_string());
        }
        ll_search::sync::state::write_readable_vaults(config_dir, &listed).unwrap();
    }

    #[test]
    fn resolve_peers_returns_empty_when_nothing_is_federated() {
        let d = tempfile::tempdir().unwrap();
        let conn = conn_with_model("model-x");
        let peers = resolve_peers(&conn, Some(d.path().to_string_lossy().to_string()), None, false);
        assert!(peers.is_empty());
        assert!(!d.path().join("vaults.json").exists(),
            "a plain, never-federated query must not create a registry — reading is never a write");
    }

    #[test]
    fn resolve_peers_stays_scoped_to_the_named_vault() {
        let d = tempfile::tempdir().unwrap();
        two_vault_profiles(d.path());
        seed_peer(&d.path().join("work"), "v-someone", "model-x");
        let conn = conn_with_model("model-x");

        let peers = resolve_peers(
            &conn,
            Some(d.path().to_string_lossy().to_string()),
            Some("/v/personal".to_string()),
            false,
        );
        assert!(peers.is_empty(), "personal has no peer cache of its own — work's must not leak in");
    }

    #[test]
    fn resolve_peers_all_widens_across_every_registered_vault() {
        let d = tempfile::tempdir().unwrap();
        two_vault_profiles(d.path());
        seed_peer(&d.path().join("work"), "v-someone", "model-x");
        let conn = conn_with_model("model-x");

        let peers = resolve_peers(&conn, Some(d.path().to_string_lossy().to_string()), None, true);
        assert_eq!(peers.len(), 1, "--all must surface the work profile's peer cache too");
        assert_eq!(peers[0].0, "v-someone");
    }

    /// With more than one vault registered, guessing which one the caller
    /// meant is exactly the case where being wrong leaks across vaults —
    /// so an unresolvable vault must fail loud, never silently widen or
    /// silently return nothing that could be mistaken for "no peers exist".
    #[test]
    #[should_panic(expected = "no vault profile")]
    fn resolve_peers_fails_loud_rather_than_search_the_wrong_vault() {
        let d = tempfile::tempdir().unwrap();
        two_vault_profiles(d.path());
        seed_peer(&d.path().join("work"), "v-someone", "model-x");
        let conn = conn_with_model("model-x");

        let _ = resolve_peers(
            &conn,
            Some(d.path().to_string_lossy().to_string()),
            Some("/v/unregistered".to_string()),
            false,
        );
    }

    /// The branch this whole correction exists for: an unmigrated, real-shaped
    /// install (`federation/config.json` present, no `vaults.json` at all) must
    /// still surface its own peer cache with no `vault_path` supplied — the
    /// direct plugin_data-as-scope path, not the registry.
    #[test]
    fn resolve_peers_finds_its_own_peers_on_an_unmigrated_legacy_install() {
        let d = tempfile::tempdir().unwrap();
        legacy_install(d.path(), "/home/r/brain");
        seed_peer(d.path(), "v-someone", "model-x");
        let conn = conn_with_model("model-x");

        let peers = resolve_peers(&conn, Some(d.path().to_string_lossy().to_string()), None, false);
        assert_eq!(peers.len(), 1, "an unmigrated single-vault install must still find its own peers");
        assert_eq!(peers[0].0, "v-someone");
        assert!(!d.path().join("vaults.json").exists(),
            "resolving the legacy scope must not create a registry either");
    }

    /// A pre-v5 install: federation/config.json present, no vaults.json.
    fn legacy_install(plugin_data: &Path, vault: &str) {
        std::fs::create_dir_all(plugin_data.join("federation")).unwrap();
        std::fs::write(
            plugin_data.join("federation/config.json"),
            serde_json::json!({
                "identity": {"displayName": "robin", "pubkey": "ed25519:AAAA"},
                "visibility": {"default": "private", "rules": []},
                "hub": {"endpoint": "wss://h.example/ws"},
                "vault_path": vault
            }).to_string(),
        ).unwrap();
    }

    #[test]
    fn vault_add_creates_an_isolated_config_dir() {
        let d = tempfile::tempdir().unwrap();
        legacy_install(d.path(), "/home/r/brain");

        vault_add(d.path(), Path::new("/home/r/work-vault"), "work").unwrap();

        let profiles = ll_search::sync::registry::load(d.path()).unwrap();
        let work = profiles.iter().find(|p| p.id == "work").unwrap();
        assert!(work.config_dir.exists());
        assert_ne!(work.config_dir, d.path(),
            "a second vault must not share the first's seed entry or sync state");
    }

    #[test]
    fn vault_add_refuses_a_duplicate_vault_path() {
        let d = tempfile::tempdir().unwrap();
        legacy_install(d.path(), "/home/r/brain");
        let err = vault_add(d.path(), Path::new("/home/r/brain"), "dupe").unwrap_err();
        assert!(err.to_string().contains("already"));
    }

    /// `registry::add` also rejects a duplicate vault_path, and its error also
    /// contains "already" — so the test above passes even if vault_add's own
    /// upfront check is deleted. What that upfront check actually buys is
    /// failing before `create_dir_all` runs, so a rejected `vault_add` leaves
    /// no orphan config dir behind. Pin that directly.
    #[test]
    fn vault_add_refuses_a_duplicate_vault_path_before_creating_its_config_dir() {
        let d = tempfile::tempdir().unwrap();
        legacy_install(d.path(), "/home/r/brain");
        let _ = vault_add(d.path(), Path::new("/home/r/brain"), "dupe");
        assert!(!d.path().join("dupe").exists(),
            "a rejected vault_add must not leave a half-registered config dir on disk");
    }

    /// Spec:334 is not met for a link and the report has to say so in every
    /// branch, because the person reading it is deciding whether their notes
    /// are still on the other machine.
    ///
    /// **Every branch is pinned as exact text, not as a wordlist.** A list of
    /// banned words checks that the report avoids five spellings of "deleted"
    /// and says nothing at all about what it does say — a first sentence
    /// rewritten to claim the opposite passes it, and the next author reaches
    /// for a synonym the list has never heard of. `revoke_report` is a
    /// function rather than a run of `eprintln!`s inside `main`'s arm exactly
    /// so the lines that must not lie can be compared whole.
    ///
    /// The wordlist stays below as a second net over the same four strings.
    #[test]
    fn the_revoke_report_says_the_same_four_things_and_no_others() {
        use ed25519_dalek::SigningKey;
        use ll_search::sync::key_id::KeyId;
        use ll_search::sync::link::Revoked;
        let other =
            KeyId::from_pubkey(&SigningKey::from_bytes(&[11u8; 32]).verifying_key());
        let id = other.as_str();
        let withdrew = |n: usize| {
            format!(
                "Withdrew {n} link grant(s) issued to {id}. The hub acknowledged it and \
                 stops authorising that key.\n"
            )
        };
        let inbound = format!(
            "The link {id} issued to THIS machine still stands. It is that machine's own \
             statement and only it can withdraw it.\n"
        );
        let untouched = "Nothing was deleted. A link covers every vault its issuer owns, so it \
             names no cached directory to take, and federation/data/peers/ is exactly as it \
             was. Data that machine already fetched is not recalled either — it stops being \
             served, and it drops what the withdrawal names on its next sync.\n";

        let report = |grant_ids: Vec<String>, inbound_remains: bool| {
            revoke_report(&Revoked { grant_ids, inbound_remains }, &other)
        };
        assert_eq!(report(vec![], false), format!("{}{untouched}", withdrew(0)));
        assert_eq!(report(vec![], true), format!("{}{inbound}{untouched}", withdrew(0)));
        assert_eq!(
            report(vec!["abc".into()], false),
            format!("{}{untouched}", withdrew(1))
        );
        assert_eq!(
            report(vec!["abc".into(), "def".into()], true),
            format!("{}{inbound}{untouched}", withdrew(2))
        );

        // The same four strings, against the words that would make any of
        // them a claim about somebody's notes coming back — and against a
        // bigger hammer, because there is no `--force` on this command and a
        // report that named one would be teaching the reflex.
        for text in [
            report(vec![], false),
            report(vec![], true),
            report(vec!["abc".into()], false),
            report(vec!["abc".into()], true),
        ] {
            for lie in ["Removed", "wiped", "erased", "purged", "force"] {
                assert!(!text.contains(lie), "the report must not say {lie:?}: {text}");
            }
        }
    }

    /// clap builds the parser at runtime, so a malformed argument definition
    /// is a panic on first invocation, not a compile error — a subcommand
    /// with a positional `bool` clap refuses to build once shipped green
    /// through this whole suite. `debug_assert` runs every check clap would
    /// run when the command is actually invoked, over every subcommand at
    /// once.
    #[test]
    fn the_cli_definition_is_one_clap_will_build() {
        use clap::CommandFactory;
        Cli::command().debug_assert();
    }

    /// Same hazard `seed_store`'s own tests pin, for the same reason: the
    /// keyring is a system store, and a test that reaches it can stomp the
    /// developer's real federation seed. Pinned once for the whole binary
    /// rather than per test — `set_var`/`remove_var` pairs race across
    /// parallel test threads.
    static SEED_BACKEND: std::sync::Once = std::sync::Once::new();
    fn pin_file_backend() {
        SEED_BACKEND.call_once(|| std::env::set_var("LL_SEED_BACKEND", "encrypted"));
    }

    /// A config dir already holding `seed`, written through the backend
    /// directly rather than through `recover` — a fixture built by the code
    /// under test can only agree with it.
    fn seeded_dir(seed: [u8; 32]) -> tempfile::TempDir {
        pin_file_backend();
        let dir = tempfile::tempdir().unwrap();
        ll_search::sync::seed_store::write_encrypted(dir.path(), &seed).unwrap();
        dir
    }

    fn loaded_seed(dir: &Path) -> [u8; 32] {
        ll_search::sync::seed_store::load_only(dir).unwrap().unwrap().signing_key.to_bytes()
    }

    #[test]
    fn recovering_restores_the_same_identity() {
        pin_file_backend();
        let original = [42u8; 32];
        let phrase = ll_search::sync::words::recovery_phrase(&original).unwrap();
        let dir = tempfile::tempdir().unwrap();
        recover(dir.path(), &phrase, false).unwrap();
        assert_eq!(loaded_seed(dir.path()), original);
    }

    #[test]
    fn recovering_over_an_existing_identity_requires_force() {
        let dir = seeded_dir([7u8; 32]);
        let phrase = ll_search::sync::words::recovery_phrase(&[42u8; 32]).unwrap();
        let err = recover(dir.path(), &phrase, false).unwrap_err();
        assert!(err.to_string().contains("--force"),
            "silently replacing a working identity would orphan every grant it holds");
        assert_eq!(loaded_seed(dir.path()), [7u8; 32],
            "a refused recovery must leave the identity it refused to replace exactly as it was");
    }

    /// Plant the hub's last answer about what this key may read.
    fn list_one_readable_vault(dir: &Path) {
        ll_search::sync::state::write_readable_vaults(
            dir,
            &ll_search::sync::state::ReadableVaults { at: 1, vault_ids: vec!["v-peer".into()] },
        )
        .unwrap();
    }

    fn a_listing_is_here(dir: &Path) -> bool {
        ll_search::sync::state::read_readable_vaults(dir).unwrap().is_some()
    }

    /// **A recovery takes the outgoing key's read authority with it.**
    ///
    /// `readable-vaults.json` records what the hub last allowed the key that
    /// was here to read. Recovering puts a different key on this machine and
    /// touches nothing else — `config.json` is not rewritten either, which is
    /// deliberate and is how `ll status` still reports RECOVERED — so the file
    /// would otherwise outlive the identity that earned it and every reader
    /// that trusts it would serve the old key's caches under the new one.
    ///
    /// Deleted rather than checked, because absent already means no authority
    /// in every reader, including the ones that hold no key and cannot tell
    /// whose answer it was. `ll sync` writes the new key's answer next cycle.
    #[test]
    fn a_recovery_leaves_no_read_authority_for_any_reader() {
        let dir = seeded_dir([7u8; 32]);
        list_one_readable_vault(dir.path());
        // The dangerous state has to be reachable, or the assertion below
        // passes against a file that was never written.
        assert!(a_listing_is_here(dir.path()), "the fixture must plant a readable listing");

        let phrase = ll_search::sync::words::recovery_phrase(&[42u8; 32]).unwrap();
        recover(dir.path(), &phrase, true).unwrap();

        assert_eq!(loaded_seed(dir.path()), [42u8; 32], "the identity did change");
        assert!(!a_listing_is_here(dir.path()),
            "the new key inherited the old key's answer about what it may read");
    }

    /// The other wrong answer, and the reason this is not an unconditional
    /// delete. Recovering the identity already here needs no `--force` on
    /// purpose — checking that the phrase in the drawer is the right one must
    /// not be the case that trains a reach for it — and that check must not
    /// silently cost a working machine its read authority until the next sync.
    #[test]
    fn recovering_the_identity_already_here_keeps_the_listing() {
        let dir = seeded_dir([7u8; 32]);
        list_one_readable_vault(dir.path());

        let phrase = ll_search::sync::words::recovery_phrase(&[7u8; 32]).unwrap();
        recover(dir.path(), &phrase, false).unwrap();

        assert!(a_listing_is_here(dir.path()),
            "nothing was replaced, so the hub's answer still describes this key");
    }

    /// **The quietest path through `recover`, and the one a "was anything
    /// replaced?" test cannot see.** A config dir holding a listing and no
    /// readable seed replaces nothing — `load_only` reports every miss as
    /// `Ok(None)` — so it needs no `--force`, warns about nothing, and would
    /// keep a listing it cannot show it wrote.
    ///
    /// Reachable: a keyring backend whose Keychain item is gone, a config dir
    /// copied while its seed stayed behind in the source Keychain, an
    /// encrypted seed deleted while `federation/` survived. The listing is not
    /// evidence against any of them — it proves an identity existed when the
    /// cycle wrote it, not that the identity is still here.
    ///
    /// So the rule is the identity that earned the listing, not the fact of a
    /// replacement: `ReadAuthority::load` already refuses to treat a machine
    /// with no identity as a machine with nothing to read.
    #[test]
    fn a_listing_with_no_readable_seed_behind_it_is_dropped_too() {
        pin_file_backend();
        let dir = tempfile::tempdir().unwrap();
        list_one_readable_vault(dir.path());
        assert!(a_listing_is_here(dir.path()), "the fixture must plant a readable listing");
        assert!(
            ll_search::sync::seed_store::load_only(dir.path()).unwrap().is_none(),
            "and no seed, which is what makes this the quiet path"
        );

        let phrase = ll_search::sync::words::recovery_phrase(&[42u8; 32]).unwrap();
        // No `--force`: there was no identity to replace, which is the point.
        recover(dir.path(), &phrase, false).unwrap();

        assert_eq!(loaded_seed(dir.path()), [42u8; 32]);
        assert!(!a_listing_is_here(dir.path()),
            "a machine that cannot show it wrote this listing must not keep it");
    }

    /// **The order, and it is the half that cannot be recovered from.** The
    /// listing is dropped BEFORE the seed moves, so a failure leaves the old
    /// identity with no listing — one sync away from correct. The other order
    /// leaves the new identity holding the old key's answer, and nothing
    /// afterwards knows it is wrong.
    ///
    /// Proved by making the drop fail rather than by reading the code's order.
    /// The mechanism is arbitrary — `readable-vaults.json` is planted as a
    /// directory, which `remove_file` refuses — and it is chosen so that
    /// EXACTLY ONE thing fails: `store_seed` writes `.seed-meta.json` and the
    /// encrypted seed beside it in a directory that is still perfectly
    /// writable, so a seed that did not move can only be this.
    #[test]
    fn a_listing_that_cannot_be_dropped_stops_the_recovery_before_the_seed_moves() {
        let dir = seeded_dir([7u8; 32]);
        std::fs::create_dir_all(
            ll_search::sync::config::readable_vaults_path(dir.path()),
        )
        .unwrap();

        let phrase = ll_search::sync::words::recovery_phrase(&[42u8; 32]).unwrap();
        let err = recover(dir.path(), &phrase, true).unwrap_err();

        assert!(err.to_string().contains("read"),
            "the error says what it could not drop and why that stopped it: {err}");
        assert_eq!(loaded_seed(dir.path()), [7u8; 32],
            "the identity moved while its predecessor's read authority stayed behind");
    }

    /// And a refused recovery changes nothing at all — the identity was
    /// already pinned above, the listing is pinned here.
    #[test]
    fn a_refused_recovery_leaves_the_listing_where_it_was() {
        let dir = seeded_dir([7u8; 32]);
        list_one_readable_vault(dir.path());

        let phrase = ll_search::sync::words::recovery_phrase(&[42u8; 32]).unwrap();
        assert!(recover(dir.path(), &phrase, false).is_err());

        assert!(a_listing_is_here(dir.path()),
            "a recovery that did not happen must not take the read authority with it");
    }

    #[test]
    fn force_replaces_the_identity_and_names_what_it_replaced() {
        let dir = seeded_dir([7u8; 32]);
        let phrase = ll_search::sync::words::recovery_phrase(&[42u8; 32]).unwrap();
        let outcome = recover(dir.path(), &phrase, true).unwrap();
        assert_eq!(loaded_seed(dir.path()), [42u8; 32]);
        let replaced = outcome.replaced.expect("a replaced identity must be named, not merely gone");
        assert_eq!(replaced, key_id_of(&[7u8; 32]));
        assert_ne!(replaced, outcome.key_id);
    }

    /// The decision the plan left open. `--force` exists to authorise losing
    /// an identity; recovering the identity already here loses nothing, so
    /// there is nothing for it to authorise. Requiring it anyway would make
    /// the safe idempotent case — checking that the phrase in the drawer is
    /// the right one — the case that teaches the user to type `--force`.
    #[test]
    fn recovering_the_identity_already_here_needs_no_force() {
        let dir = seeded_dir([42u8; 32]);
        let phrase = ll_search::sync::words::recovery_phrase(&[42u8; 32]).unwrap();
        let outcome = recover(dir.path(), &phrase, false).unwrap();
        assert!(outcome.replaced.is_none(), "nothing was replaced, so nothing may be reported as replaced");
        assert_eq!(loaded_seed(dir.path()), [42u8; 32]);
        assert_eq!(outcome.key_id, key_id_of(&[42u8; 32]));
    }

    /// Order, not just outcome: the phrase is read before the machine's own
    /// identity is. Checking `--force` first would answer a typo with the
    /// flag that destroys an identity, which is the last place a confused
    /// user should be pointed.
    #[test]
    fn a_phrase_that_is_not_a_phrase_is_refused_before_the_seed_is_touched() {
        let dir = seeded_dir([7u8; 32]);
        for force in [false, true] {
            let err = recover(dir.path(), "zzzz not a recovery phrase", force).unwrap_err();
            assert!(!err.to_string().contains("--force"),
                "an unreadable phrase is not a --force question (force={force})");
            assert_eq!(loaded_seed(dir.path()), [7u8; 32],
                "an unreadable phrase must leave the existing seed untouched (force={force})");
        }
    }

    fn key_id_of(seed: &[u8; 32]) -> String {
        use ed25519_dalek::SigningKey;
        ll_search::sync::key_id::KeyId::from_pubkey(&SigningKey::from_bytes(seed).verifying_key())
            .as_str()
            .to_string()
    }

    /// `--force` is a flag and the phrase is a positional: the shape clap
    /// builds its parser from, which it does at runtime.
    #[test]
    fn recover_takes_the_phrase_positionally_and_force_as_a_flag() {
        use clap::Parser;
        match Cli::parse_from(["ll-search", "recover", "abandon abandon", "--force"]).command {
            Commands::Recover { phrase, force, .. } => {
                assert_eq!(phrase, "abandon abandon");
                assert!(force);
            }
            other => panic!("wrong subcommand: {:?}", std::mem::discriminant(&other)),
        }
        assert!(!matches!(
            Cli::parse_from(["ll-search", "recover", "abandon abandon"]).command,
            Commands::Recover { force: true, .. }
        ));
    }

}
