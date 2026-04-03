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
        incremental: bool,
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
    },
    Benchmark {
        db_path: String,
        #[arg(long, default_value = "bge-small")]
        model_a: String,
        #[arg(long, default_value = "embeddinggemma")]
        model_b: String,
        queries: Vec<String>,
    },
}

fn parse_model(s: &str) -> ll_search::model::KnownModel {
    match s {
        "bge-small" | "bge" => ll_search::model::KnownModel::BgeSmallEnV15,
        "embeddinggemma" | "gemma" => ll_search::model::KnownModel::EmbeddingGemma300m,
        other => panic!("Unknown model: {}. Use 'bge-small' or 'embeddinggemma'", other),
    }
}

fn out<T: serde::Serialize>(data: &T) {
    println!("{}", serde_json::to_string_pretty(data).unwrap());
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

fn main() {
    let cli = Cli::parse();
    match cli.command {
        Commands::Version => {
            println!("{}", env!("CARGO_PKG_VERSION"));
        }
        Commands::Index { vault_path, db_path, force, sync, config_dir, .. } => {
            let conn = ll_search::db::open_db(&db_path);
            let result = ll_search::db::reindex(&conn, &vault_path, force);
            out(&result);
            if sync {
                let config_dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
                if let Ok(config) = ll_search::sync::config::load_config(&config_dir) {
                    match ll_search::sync::client::sync_all(
                        std::path::Path::new(&db_path),
                        std::path::Path::new(&vault_path),
                        &config_dir,
                        &config,
                    ) {
                        Ok(sync_result) => eprintln!("Sync: uploaded {} notes, downloaded {} peers",
                            sync_result.uploaded_notes, sync_result.downloaded.len()),
                        Err(e) => eprintln!("Sync failed: {e}"),
                    }
                }
            }
        }
        Commands::Query { db_path, text, top, config_dir } => {
            let conn = ll_search::db::open_db(&db_path);
            let peers = resolve_peers(&conn, config_dir);
            let results = if peers.is_empty() {
                ll_search::search::hybrid_query(&conn, &text, top)
            } else {
                ll_search::search::hybrid_query_federated(&conn, &text, top, &peers)
            };
            out(&results);
        }
        Commands::Similar { db_path, note_path, top } => {
            let conn = ll_search::db::open_db(&db_path);
            let results = ll_search::search::similar_notes(&conn, &note_path, top);
            out(&results);
        }
        Commands::Cluster { db_path, threshold } => {
            let conn = ll_search::db::open_db(&db_path);
            let results = ll_search::search::cluster_notes(&conn, threshold);
            out(&results);
        }
        Commands::Discriminate { db_path, threshold, paths } => {
            let conn = ll_search::db::open_db(&db_path);
            let results = ll_search::search::discriminate_pairs(&conn, &paths, threshold);
            out(&results);
        }
        Commands::ReflectScan { db_path, queries, top, candidates, threshold, config_dir } => {
            let conn = ll_search::db::open_db(&db_path);
            let peers = resolve_peers(&conn, config_dir);
            let result = if peers.is_empty() {
                ll_search::search::reflect_scan(&conn, &queries, top, candidates, threshold)
            } else {
                ll_search::search::reflect_scan_federated(&conn, &queries, top, candidates, threshold, &peers)
            };
            out(&result);
        }
        Commands::Embed { text } => {
            let vec = ll_search::embed::embed_query(&text);
            out(&vec);
        }
        Commands::Status { db_path, vault_path } => {
            let conn = ll_search::db::open_db(&db_path);
            let status = ll_search::db::get_status(&conn, &vault_path);
            out(&status);
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
        Commands::Sync { db_path, vault_path, config_dir } => {
            let config_dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
            let config = ll_search::sync::config::load_config(&config_dir)
                .expect("failed to load federation config");
            let result = ll_search::sync::client::sync_all(
                std::path::Path::new(&db_path),
                std::path::Path::new(&vault_path),
                &config_dir,
                &config,
            )
            .expect("sync failed");
            out(&result);
        }
        Commands::Rerank { db_path, query, top, candidates, config_dir } => {
            let conn = ll_search::db::open_db(&db_path);
            let peers = resolve_peers(&conn, config_dir);
            let candidate_results = if peers.is_empty() {
                ll_search::search::hybrid_query(&conn, &query, candidates)
            } else {
                ll_search::search::hybrid_query_federated(&conn, &query, candidates, &peers)
            };
            if candidate_results.is_empty() {
                out(&Vec::<ll_search::rerank::RerankResult>::new());
                return;
            }
            let paths: Vec<String> = candidate_results.iter().map(|r| r.path.clone()).collect();
            let bodies = ll_search::search::batch_load_bodies_federated(&conn, &peers, &paths);
            let docs: Vec<(String, String)> = candidate_results
                .iter()
                .filter_map(|r| {
                    let body = bodies.get(&r.path)?;
                    Some((r.path.clone(), body.clone()))
                })
                .collect();
            let reranked = ll_search::rerank::rerank(&query, &docs, top);
            out(&reranked);
        }
        Commands::Watch { vault_path, db_path, sync_interval, config_dir, pid_file } => {
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
            };
            ll_search::sync::watch::run_watch(cfg).expect("watch failed");
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
