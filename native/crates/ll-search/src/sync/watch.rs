use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher};
use tokio::sync::Notify;
use tokio::sync::watch as watch_chan;

use super::config::FederationConfig;

const DEBOUNCE_WINDOW: Duration = Duration::from_millis(1500);
const POLL_TICK: Duration = Duration::from_millis(200);
const RESYNC_INTERVAL: Duration = Duration::from_secs(300);
const SHUTDOWN_DRAIN: Duration = Duration::from_secs(2);

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
    version_path: PathBuf,
}

impl PidGuard {
    fn new(path: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))?;
        const MAX_RETRIES: u32 = 3;
        for _ in 0..MAX_RETRIES {
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
            {
                Ok(mut f) => {
                    write!(f, "{}", std::process::id())?;
                    let version_path = path.with_file_name("watch.version");
                    std::fs::write(&version_path, env!("CARGO_PKG_VERSION")).ok();
                    return Ok(PidGuard {
                        path: path.to_path_buf(),
                        version_path,
                    });
                }
                Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                    let raw = std::fs::read_to_string(path).unwrap_or_default();
                    let trimmed = raw.trim();
                    if trimmed.is_empty() {
                        std::thread::sleep(Duration::from_millis(50));
                        continue;
                    }
                    let existing: Option<u32> = trimmed.parse().ok();
                    match existing {
                        Some(pid) if pid != std::process::id() && is_process_running(pid) => {
                            return Err(std::io::Error::new(
                                ErrorKind::AlreadyExists,
                                format!("daemon already running with pid {}", pid),
                            ));
                        }
                        _ => {
                            std::fs::remove_file(path).ok();
                            std::thread::sleep(Duration::from_millis(50));
                        }
                    }
                }
                Err(e) => return Err(e),
            }
        }
        Err(std::io::Error::other(
            "exceeded retry budget acquiring pid file",
        ))
    }
}

impl Drop for PidGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(&self.version_path);
    }
}

/// State updated by the (sync) notify callback and drained by the async consumer.
///
/// Lock is held only briefly (filter + insert/take), never across an `.await`.
/// This is exactly the shape `std::sync::Mutex` is the right pick for; using
/// `tokio::sync::Mutex` would require the callback to spawn into the runtime,
/// which is the cross-boundary trickiness we are trying to avoid.
struct DebounceState {
    dirty_since: Option<Instant>,
    touched: HashSet<PathBuf>,
}

pub async fn run_watch_async(cfg: WatchConfig) -> anyhow::Result<()> {
    let _pid = PidGuard::new(&cfg.pid_file)?;

    let (shutdown_tx, mut shutdown_rx) = watch_chan::channel(false);
    spawn_shutdown_signals(shutdown_tx.clone());

    eprintln!("Initial reindex...");
    do_reindex_blocking(&cfg.db_path, &cfg.vault_path).await;

    let fed_config = super::config::load_config(&cfg.config_dir).ok();
    if let Some(ref fc) = fed_config {
        eprintln!("Initial sync...");
        do_sync(&cfg.db_path, &cfg.vault_path, &cfg.config_dir, fc).await;
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

    let debounce = Arc::new(Mutex::new(DebounceState {
        dirty_since: None,
        touched: HashSet::new(),
    }));
    let notify = Arc::new(Notify::new());

    let vault_search_dir = cfg.vault_path.join(".vault-search");
    let db_dir = cfg.db_path.parent().unwrap_or(&cfg.db_path).to_path_buf();
    let debounce_cb = Arc::clone(&debounce);
    let notify_cb = Arc::clone(&notify);
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, _>| {
        let Ok(event) = res else { return };
        let mut touched_paths: Vec<PathBuf> = Vec::new();
        for p in &event.paths {
            if p.starts_with(&vault_search_dir) || p.starts_with(&db_dir) {
                continue;
            }
            if p.extension().is_some_and(|e| e == "md") {
                touched_paths.push(p.clone());
            }
        }
        if touched_paths.is_empty() {
            return;
        }
        if let Ok(mut state) = debounce_cb.lock() {
            if state.dirty_since.is_none() {
                state.dirty_since = Some(Instant::now());
            } else {
                // Extend the window: the latest event resets the wait clock.
                state.dirty_since = Some(Instant::now());
            }
            for p in touched_paths {
                state.touched.insert(p);
            }
        }
        notify_cb.notify_one();
    })?;
    watcher.watch(cfg.vault_path.as_ref(), RecursiveMode::Recursive)?;

    eprintln!(
        "Watching {} (sync every {}s, PID {})",
        cfg.vault_path.display(),
        cfg.sync_interval.as_secs(),
        std::process::id()
    );

    let mut federation_tick = tokio::time::interval(cfg.sync_interval);
    federation_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    federation_tick.tick().await; // consume the immediate first tick

    let mut resync_tick = tokio::time::interval(RESYNC_INTERVAL);
    resync_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    resync_tick.tick().await;

    loop {
        tokio::select! {
            biased;
            _ = shutdown_rx.changed() => break,
            _ = notify.notified() => {}
            _ = tokio::time::sleep(POLL_TICK) => {}
            _ = federation_tick.tick() => {
                if let Some(ref fc) = fed_config {
                    do_sync(&cfg.db_path, &cfg.vault_path, &cfg.config_dir, fc).await;
                }
            }
            _ = resync_tick.tick() => {
                do_reindex_blocking(&cfg.db_path, &cfg.vault_path).await;
            }
        }

        let should_fire = {
            let mut state = debounce.lock().expect("debounce mutex poisoned");
            match state.dirty_since {
                Some(since) if since.elapsed() >= DEBOUNCE_WINDOW => {
                    state.dirty_since = None;
                    let touched = std::mem::take(&mut state.touched);
                    Some(touched)
                }
                _ => None,
            }
        };
        if let Some(touched) = should_fire {
            eprintln!("Debounced reindex: {} paths", touched.len());
            do_reindex_blocking(&cfg.db_path, &cfg.vault_path).await;
        }
    }

    if let Some(mut child) = librarian_child {
        eprintln!("Stopping librarian (PID {})...", child.id());
        let _ = child.kill();
        let _ = child.wait();
    }

    // Allow tasks to drain briefly before returning.
    let _ = tokio::time::timeout(SHUTDOWN_DRAIN, async {}).await;
    eprintln!("Watch stopped");
    Ok(())
}

fn spawn_shutdown_signals(tx: watch_chan::Sender<bool>) {
    // We do not enable tokio's `signal` feature (per docs/baseline/rust.md). Reuse the
    // existing `signal_hook` (unix) / `ctrlc` (windows) crates and bridge into a tokio
    // watch channel so async tasks can observe shutdown via `select!`.
    let flag = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    {
        if let Err(e) = signal_hook::flag::register(signal_hook::consts::SIGINT, Arc::clone(&flag)) {
            eprintln!("SIGINT handler install failed: {e}");
        }
        if let Err(e) = signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&flag)) {
            eprintln!("SIGTERM handler install failed: {e}");
        }
    }
    #[cfg(not(unix))]
    {
        let flag_clone = Arc::clone(&flag);
        let _ = ctrlc::set_handler(move || flag_clone.store(true, Ordering::Relaxed));
    }
    tokio::spawn(async move {
        loop {
            if flag.load(Ordering::Relaxed) {
                let _ = tx.send(true);
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
}

async fn do_reindex_blocking(db_path: &Path, vault_path: &Path) {
    let db = db_path.to_path_buf();
    let vault = vault_path.to_path_buf();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let db_str = db.to_string_lossy();
        let vault_str = vault.to_string_lossy();
        let conn = crate::db::open_db(&db_str)?;
        match crate::db::reindex(&conn, &vault_str, false) {
            Ok(result) => eprintln!(
                "Reindex: {} embedded, {} deleted, {} total",
                result.embedded, result.deleted, result.total
            ),
            Err(e) => eprintln!("Reindex failed: {e}"),
        }
        conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);").ok();
        Ok(())
    })
    .await;
    if let Err(e) = result {
        eprintln!("Reindex task panicked: {e}");
    }
}

async fn do_sync(
    db_path: &Path,
    vault_path: &Path,
    config_dir: &Path,
    config: &FederationConfig,
) {
    match super::client::sync_all_async(db_path, vault_path, config_dir, config).await {
        Ok(result) => {
            eprintln!(
                "Sync: {} uploaded, {} downloaded, {} skipped",
                result.uploaded_notes,
                result.downloaded.len(),
                result.skipped.len()
            );
            if !result.downloaded.is_empty() {
                let db = db_path.to_path_buf();
                let _ = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                    let db_str = db.to_string_lossy();
                    let conn = crate::db::open_db(&db_str)?;
                    crate::db::compute_sessions(&conn);
                    crate::db::compute_project_phases(&conn);
                    Ok(())
                })
                .await;
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

#[cfg(test)]
mod debounce_tests {
    use super::*;

    fn touched(state: &Mutex<DebounceState>) -> usize {
        state.lock().unwrap().touched.len()
    }

    #[test]
    fn fresh_state_does_not_fire() {
        let state = Mutex::new(DebounceState {
            dirty_since: None,
            touched: HashSet::new(),
        });
        let s = state.lock().unwrap();
        assert!(s.dirty_since.is_none());
        assert_eq!(s.touched.len(), 0);
    }

    #[test]
    fn dirty_since_resets_on_subsequent_touch() {
        let state = Mutex::new(DebounceState {
            dirty_since: None,
            touched: HashSet::new(),
        });
        {
            let mut s = state.lock().unwrap();
            s.dirty_since = Some(Instant::now());
            s.touched.insert(PathBuf::from("a.md"));
        }
        let first = state.lock().unwrap().dirty_since.unwrap();
        std::thread::sleep(Duration::from_millis(20));
        {
            let mut s = state.lock().unwrap();
            // The callback resets dirty_since to now on every event so the window
            // extends with each touch (desired: a continuous burst defers reindex
            // until the burst stops).
            s.dirty_since = Some(Instant::now());
            s.touched.insert(PathBuf::from("b.md"));
        }
        let second = state.lock().unwrap().dirty_since.unwrap();
        assert!(second > first, "window must extend on each touch");
        assert_eq!(touched(&state), 2);
    }

    #[test]
    fn drain_clears_state() {
        let state = Mutex::new(DebounceState {
            dirty_since: Some(Instant::now() - Duration::from_secs(60)),
            touched: HashSet::from([PathBuf::from("a.md"), PathBuf::from("b.md")]),
        });
        let drained = {
            let mut s = state.lock().unwrap();
            assert!(s.dirty_since.unwrap().elapsed() >= DEBOUNCE_WINDOW);
            s.dirty_since = None;
            std::mem::take(&mut s.touched)
        };
        assert_eq!(drained.len(), 2);
        let s = state.lock().unwrap();
        assert!(s.dirty_since.is_none());
        assert_eq!(s.touched.len(), 0);
    }

    #[test]
    fn duplicate_touches_collapse_to_one() {
        let state = Mutex::new(DebounceState {
            dirty_since: None,
            touched: HashSet::new(),
        });
        let same_path = PathBuf::from("a.md");
        for _ in 0..10 {
            let mut s = state.lock().unwrap();
            if s.dirty_since.is_none() {
                s.dirty_since = Some(Instant::now());
            }
            s.touched.insert(same_path.clone());
        }
        assert_eq!(touched(&state), 1, "HashSet must dedup repeated atomic writes to one file");
    }
}
