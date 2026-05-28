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
        /// Override the hub endpoint URL. When provided, sync skips reading
        /// federation/config.json from disk. Falls back to LL_HUB_ENDPOINT env
        /// var if the flag is absent. Skills calling this during onboarding
        /// (before config is written) MUST provide one of the two.
        #[arg(long)]
        hub_endpoint: Option<String>,
        /// Override the peer_id. When provided together with --hub-endpoint,
        /// sync uses this identity instead of reading federation/config.json.
        /// Skills calling this during onboarding (before config is written)
        /// pass the peer_id returned by the redeem response. Falls back to
        /// LL_PEER_ID env var if the flag is absent.
        #[arg(long)]
        peer_id: Option<String>,
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
    EvalFunnel {
        db_path: String,
        #[arg(long, default_value_t = 2)]
        min_links: usize,
        #[arg(long, help = "Cap the number of queries (random sample)")]
        limit: Option<usize>,
    },
    #[cfg(feature = "nli")]
    NliCheck {
        text_a: String,
        text_b: String,
    },
    #[cfg(feature = "nli")]
    NliBatch {
        text_a: String,
        texts_b_file: String,
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

fn resolve_peers(conn: &rusqlite::Connection, config_dir: Option<String>) -> Vec<(String, rusqlite::Connection)> {
    let config_dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
    let fed_config_path = config_dir.join("federation").join("config.json");
    if !fed_config_path.exists() {
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
    ll_search::search::discover_peer_dbs(&config_dir, &model_id)
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
        Commands::Query { db_path, text, top, config_dir, recency, after, before, session, project, threshold } => {
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
            let peers = resolve_peers(&conn, config_dir);
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
            let peers = resolve_peers(&conn, config_dir);
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
        Commands::Sync { db_path, vault_path, config_dir, hub_endpoint, peer_id } => {
            let hub_override = hub_endpoint
                .or_else(|| std::env::var("LL_HUB_ENDPOINT").ok());
            let peer_id_override = peer_id
                .or_else(|| std::env::var("LL_PEER_ID").ok());
            // Validate before touching the embedding model — a misconfigured
            // invocation should fail fast with a clear error, not after a
            // network round-trip to huggingface.
            if hub_override.is_some() && peer_id_override.is_none() {
                eprintln!(
                    "--hub-endpoint provided without --peer-id; pass --peer-id <id> \
                     (or set LL_PEER_ID) when bypassing federation/config.json"
                );
                std::process::exit(2);
            }
            init_embedding();
            let config_dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
            let config = ll_search::sync::config::load_config_with_override(
                &config_dir,
                hub_override.as_deref(),
                peer_id_override.as_deref(),
            )
            .expect("failed to load federation config");
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
            let peers = resolve_peers(&conn, config_dir);
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
        Commands::TunePrf { db_path, queries } => {
            let conn = ll_search::db::open_db(&db_path).expect("failed to open database");
            init_embedding();
            let store = ll_search::search::store::load_store(&conn);
            let result = ll_search::search::tune_prf(&conn, &queries, &store);
            out(&result);
        }
        #[cfg(feature = "nli")]
        Commands::NliCheck { text_a, text_b } => {
            let result = ll_search::nli::nli_check(&text_a, &text_b);
            out(&result);
        }
        #[cfg(feature = "nli")]
        Commands::NliBatch { text_a, texts_b_file } => {
            let content = std::fs::read_to_string(&texts_b_file)
                .expect("failed to read texts_b file");
            let texts_b: Vec<String> = content
                .lines()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect();
            let results = ll_search::nli::nli_batch(&text_a, &texts_b);
            out(&results);
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
