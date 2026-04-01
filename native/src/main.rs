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
        #[arg(long, default_value_t = 0.78)]
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
    DownloadBinary {
        #[arg(long)]
        version: Option<String>,
        #[arg(long)]
        config_dir: Option<String>,
        #[arg(long)]
        dest: Option<String>,
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
}

fn out<T: serde::Serialize>(data: &T) {
    println!("{}", serde_json::to_string_pretty(data).unwrap());
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
        Commands::Query { db_path, text, top } => {
            let conn = ll_search::db::open_db(&db_path);
            let results = ll_search::search::hybrid_query(&conn, &text, top);
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
        Commands::ReflectScan { db_path, queries, top, candidates, threshold } => {
            let conn = ll_search::db::open_db(&db_path);
            let result = ll_search::search::reflect_scan(&conn, &queries, top, candidates, threshold);
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
        Commands::Rerank { db_path, query, top, candidates } => {
            let conn = ll_search::db::open_db(&db_path);
            let candidate_results = ll_search::search::hybrid_query(&conn, &query, candidates);
            if candidate_results.is_empty() {
                out(&Vec::<ll_search::rerank::RerankResult>::new());
                return;
            }
            let docs: Vec<(String, String)> = candidate_results
                .iter()
                .filter_map(|r| {
                    let body: String = conn
                        .query_row(
                            "SELECT body FROM notes_content nc JOIN notes n ON nc.id = n.id WHERE n.path = ?1",
                            rusqlite::params![r.path],
                            |row| row.get(0),
                        )
                        .ok()?;
                    Some((r.path.clone(), body))
                })
                .collect();
            let reranked = ll_search::rerank::rerank(&query, &docs, top);
            out(&reranked);
        }
        Commands::DownloadBinary { version, config_dir, dest } => {
            let config_dir = ll_search::sync::config::resolve_config_dir_opt(config_dir);
            let config = ll_search::sync::config::load_config(&config_dir)
                .expect("failed to load federation config");
            let seed = ll_search::sync::auth::load_seed(
                &ll_search::sync::config::seed_path(&config_dir),
            )
            .expect("failed to load seed");
            let peer_id = &config.identity.display_name;
            let hub_url = &config.hub.endpoint;

            let version = version.unwrap_or_else(|| format!("v{}", env!("CARGO_PKG_VERSION")));
            let artifact = ll_search::sync::download::detect_artifact();
            let dest = dest.map(std::path::PathBuf::from).unwrap_or_else(|| {
                config_dir.join("bin").join(if cfg!(windows) { "ll-search.exe" } else { "ll-search" })
            });

            ll_search::sync::download::download_release(
                hub_url, &version, &artifact, &seed, peer_id, &dest,
            )
            .expect("download failed");
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
    }
}
