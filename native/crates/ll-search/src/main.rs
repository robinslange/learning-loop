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
    Status {
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

    ll_search::search::discover_peer_dbs_for(&scope, &model_id)
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
                        Ok(sync_result) => eprintln!("Sync: uploaded {} notes, downloaded {} peers",
                            sync_result.uploaded_notes, sync_result.downloaded.len()),
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
        Commands::Status { db_path, vault_path } => {
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

    fn seed_peer(config_dir: &Path, peer: &str, model_id: &str) {
        let peer_dir = config_dir.join("federation").join("data").join("peers").join(peer);
        std::fs::create_dir_all(&peer_dir).unwrap();
        let conn = rusqlite::Connection::open(peer_dir.join("index.db")).unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO meta (key, value) VALUES ('model_id', '{model_id}');"
        )).unwrap();
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
}
