use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher};

use super::config::FederationConfig;

const DEFAULT_DEBOUNCE: Duration = Duration::from_secs(2);

pub struct WatchConfig {
    pub vault_path: PathBuf,
    pub db_path: PathBuf,
    pub config_dir: PathBuf,
    pub pid_file: PathBuf,
    pub sync_interval: Duration,
    pub librarian_script: Option<PathBuf>,
}

struct PidGuard {
    path: PathBuf,
}

impl PidGuard {
    fn new(path: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))?;
        std::fs::write(path, std::process::id().to_string())?;
        Ok(PidGuard {
            path: path.to_path_buf(),
        })
    }
}

impl Drop for PidGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

pub fn run_watch(cfg: WatchConfig) -> anyhow::Result<()> {
    let _pid = PidGuard::new(&cfg.pid_file)?;

    let stopped = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    {
        signal_hook::flag::register(signal_hook::consts::SIGINT, Arc::clone(&stopped))?;
        signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&stopped))?;
    }
    #[cfg(not(unix))]
    {
        let stopped_clone = Arc::clone(&stopped);
        ctrlc::set_handler(move || stopped_clone.store(true, Ordering::Relaxed))
            .expect("failed to set Ctrl+C handler");
    }

    eprintln!("Initial reindex...");
    do_reindex(&cfg.db_path, &cfg.vault_path);

    let fed_config = super::config::load_config(&cfg.config_dir).ok();
    if let Some(ref fc) = fed_config {
        eprintln!("Initial sync...");
        do_sync(&cfg.db_path, &cfg.vault_path, &cfg.config_dir, fc);
    }

    let mut librarian_child: Option<std::process::Child> = None;
    if let Some(ref script) = cfg.librarian_script {
        if script.exists() {
            match std::process::Command::new("node")
                .arg(script)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::inherit())
                .spawn()
            {
                Ok(child) => {
                    eprintln!("Librarian started (PID {})", child.id());
                    librarian_child = Some(child);
                }
                Err(e) => eprintln!("Failed to start librarian: {e}"),
            }
        }
    }

    let (fs_tx, fs_rx) = mpsc::channel();
    let vault_search_dir = cfg.vault_path.join(".vault-search");
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, _>| {
        if let Ok(event) = res {
            let dominated_by_md = event.paths.iter().any(|p| {
                if p.starts_with(&vault_search_dir) {
                    return false;
                }
                p.extension().map_or(false, |e| e == "md")
            });
            if dominated_by_md {
                let _ = fs_tx.send(());
            }
        }
    })?;
    watcher.watch(cfg.vault_path.as_ref(), RecursiveMode::Recursive)?;

    eprintln!(
        "Watching {} (sync every {}s, PID {})",
        cfg.vault_path.display(),
        cfg.sync_interval.as_secs(),
        std::process::id()
    );

    let mut last_sync = Instant::now();
    let mut pending_reindex = false;
    let mut last_change = Instant::now();

    while !stopped.load(Ordering::Relaxed) {
        match fs_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(()) => {
                pending_reindex = true;
                last_change = Instant::now();
                while fs_rx.try_recv().is_ok() {}
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }

        if pending_reindex && last_change.elapsed() >= DEFAULT_DEBOUNCE {
            pending_reindex = false;
            do_reindex(&cfg.db_path, &cfg.vault_path);
        }

        if fed_config.is_some() && last_sync.elapsed() >= cfg.sync_interval {
            last_sync = Instant::now();
            do_sync(
                &cfg.db_path,
                &cfg.vault_path,
                &cfg.config_dir,
                fed_config.as_ref().unwrap(),
            );
        }
    }

    if let Some(mut child) = librarian_child {
        eprintln!("Stopping librarian (PID {})...", child.id());
        let _ = child.kill();
        let _ = child.wait();
    }

    eprintln!("Watch stopped");
    Ok(())
}

fn do_reindex(db_path: &Path, vault_path: &Path) {
    let db_str = db_path.to_string_lossy();
    let vault_str = vault_path.to_string_lossy();
    let conn = match crate::db::open_db(&db_str) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Failed to open database: {e}");
            return;
        }
    };
    let result = crate::db::reindex(&conn, &vault_str, false);
    eprintln!(
        "Reindex: {} embedded, {} deleted, {} total",
        result.embedded, result.deleted, result.total
    );
    conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);").ok();
}

fn do_sync(
    db_path: &Path,
    vault_path: &Path,
    config_dir: &Path,
    config: &FederationConfig,
) {
    match super::client::sync_all(db_path, vault_path, config_dir, config) {
        Ok(result) => {
            eprintln!(
                "Sync: {} uploaded, {} downloaded, {} skipped",
                result.uploaded_notes,
                result.downloaded.len(),
                result.skipped.len()
            );
            if !result.downloaded.is_empty() {
                let db_str = db_path.to_string_lossy();
                match crate::db::open_db(&db_str) {
                    Ok(conn) => {
                        crate::db::compute_sessions(&conn);
                        crate::db::compute_project_phases(&conn);
                    }
                    Err(e) => eprintln!("Failed to open database for session compute: {e}"),
                }
            }
        }
        Err(e) => eprintln!("Sync failed: {e}"),
    }
}

#[cfg(unix)]
fn is_process_running(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_process_running(pid: u32) -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/NH"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

pub fn is_watch_running(pid_file: &Path) -> bool {
    let pid_str = match std::fs::read_to_string(pid_file) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let pid: u32 = match pid_str.trim().parse() {
        Ok(p) => p,
        Err(_) => return false,
    };
    is_process_running(pid)
}
