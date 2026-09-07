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
                    return Ok(PidGuard {
                        path: path.to_path_buf(),
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

/// Take up `config.json` if it parses; keep `current` if it does not.
///
/// The watcher used to read this file once, before the loop, and reuse that
/// value forever. `join`, `link accept` and `recover` all rewrite it under a
/// running daemon, so after any of them the watcher went on dialling the hub
/// the machine had left — and wrote THAT failure into `sync-state.json`, which
/// is the file `ll status` renders. The stale answer did not merely persist;
/// it overwrote the true one every cycle.
///
/// Keeping the last good copy is the safe direction, and it is the reason this
/// is not a bare re-read: a config saved half-written must not cost a working
/// daemon its federation until someone restarts it. `None` -> `Some` is the
/// first-join case, where the daemon started before there was anything to read.
fn reload_federation_config(
    config_dir: &Path,
    current: Option<FederationConfig>,
) -> Option<FederationConfig> {
    super::config::load_config(config_dir).ok().or(current)
}

pub async fn run_watch_async(cfg: WatchConfig) -> anyhow::Result<()> {
    let _pid = PidGuard::new(&cfg.pid_file)?;

    let (shutdown_tx, mut shutdown_rx) = watch_chan::channel(false);
    spawn_shutdown_signals(shutdown_tx.clone());

    eprintln!("Initial reindex...");
    do_reindex_blocking(&cfg.db_path, &cfg.vault_path).await;

    // Spawn the UDS duplicate-scan server alongside the fs-watcher.
    // The socket path matches DATA_FILES.nliSocket in pre-write-check.js
    // (legacy name kept for JS/Rust protocol compatibility).
    #[cfg(unix)]
    let _dup_server_task = {
        let socket_path = cfg.config_dir.join("nli.sock");
        let db_path = cfg.db_path.clone();
        let shutdown_rx_dup = shutdown_rx.clone();
        tokio::spawn(async move {
            if let Err(e) =
                crate::nli_server::run_nli_server(socket_path, db_path, shutdown_rx_dup).await
            {
                eprintln!("UDS server task exited with error: {e}");
            }
        })
    };

    let mut fed_config = super::config::load_config(&cfg.config_dir).ok();
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
                // Re-read before every cycle. `join`, `link accept` and
                // `recover` all rewrite config.json underneath a running
                // daemon, and a copy cached at startup makes the watcher go on
                // dialling a hub the machine has left -- then write THAT
                // failure into sync-state.json, which is the file `ll status`
                // renders. The stale answer does not merely persist, it
                // overwrites the true one every tick.
                //
                // A file that stops parsing keeps the last good copy rather
                // than becoming `None`: a half-written save must not cost a
                // working daemon its federation until someone restarts it.
                // `None` -> `Some` is the first-join case, where the daemon
                // started before there was anything to read.
                fed_config = reload_federation_config(&cfg.config_dir, fed_config.take());
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
        let conn = crate::db::open_or_create_db(&db_str)?;
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
                "Sync: {} uploaded, {} fetched, {} already current, {} could not be fetched",
                result.uploaded_notes,
                result.fetched.len(),
                result.unchanged_fetches.len(),
                result.skipped_fetches.len()
            );
            if !result.fetched.is_empty() {
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

    // ---------------------------------------------------------------------
    // The daemon's view of `config.json`
    // ---------------------------------------------------------------------

    /// Write a config naming `endpoint`. `ws://` to a non-loopback address is
    /// refused by `check_hub_scheme`, and the refusal NAMES the endpoint — so
    /// two such endpoints fail identically except in the one way this test
    /// needs to read.
    fn write_hub_config(config_dir: &Path, endpoint: &str) {
        let mut c = crate::sync::config::FederationConfig::test_fixture("private", vec![]);
        c.hub.endpoint = endpoint.to_string();
        crate::sync::config::write_config(config_dir, &c).unwrap();
    }

    /// An identity, so the cycle's failure is the hub one and not "no
    /// federation seed found" — which is checked before the endpoint is.
    fn plant_identity(config_dir: &Path) {
        crate::sync::test_hub::force_encrypted_seed_backend();
        crate::sync::seed_store::write_encrypted(config_dir, &[7u8; 32]).unwrap();
    }

    /// A source index the export can get past its own gate on, so the failure
    /// the test reads is the hub one and not a missing `model_id`.
    fn seed_source_db(db_path: &Path) {
        std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        let conn = crate::db::open_or_create_db(&db_path.to_string_lossy()).unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('model_id', 'test-model')",
            [],
        )
        .unwrap();
    }

    /// When the last cycle ran. A cycle that keeps failing still moves this.
    fn last_attempt(config_dir: &Path) -> i64 {
        crate::sync::state::read_state(config_dir)
            .ok()
            .flatten()
            .map(|s| s.last_attempt_at)
            .unwrap_or(0)
    }

    /// The `detail` the last cycle recorded, or empty.
    fn last_detail(config_dir: &Path) -> String {
        crate::sync::state::read_state(config_dir)
            .ok()
            .flatten()
            .and_then(|s| s.detail)
            .unwrap_or_default()
    }

    /// Generous on purpose. The daemon does a full reindex before its first
    /// federation tick, and under a loaded parallel suite that is far slower
    /// than it is alone — a fixed ten-second budget made this test fail only
    /// when the whole workspace ran, which is a flake, not a finding. When the
    /// behaviour is right this returns in well under a second.
    async fn wait_for_detail(config_dir: &Path, needle: &str) -> bool {
        for _ in 0..1200 {
            if last_detail(config_dir).contains(needle) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    /// **A `join` rewrites `config.json` underneath a running daemon.**
    ///
    /// The watcher used to read the file once, before the loop, and reuse that
    /// value forever — so after a join it went on dialling the hub the machine
    /// had left, and wrote THAT failure into `sync-state.json`, which is the
    /// file `ll status` renders. The stale answer did not merely persist: it
    /// overwrote the true one every tick.
    ///
    /// The first assertion is the reachability half. Without it, a daemon that
    /// never synced at all would pass the second one by never writing either
    /// endpoint.
    /// `#[ignore]`, and the reason is a real limit rather than a preference.
    /// This spins the whole daemon, which does a full reindex before its first
    /// federation tick. Alone it passes in under a second; inside the parallel
    /// workspace suite it does not reach that tick even given sixty seconds,
    /// so as a default-suite test it reports load, not correctness. The three
    /// tests below cover what the reload DECIDES, deterministically. This one
    /// covers the thing they cannot — that the tick calls it at all — and is
    /// run deliberately: `cargo test -p ll-search --lib -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn the_federation_tick_takes_up_a_config_rewritten_underneath_it() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().join("vault");
        let config_dir = tmp.path().join("cfg");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        let db_path = tmp.path().join("index.db");
        seed_source_db(&db_path);
        plant_identity(&config_dir);

        let before = "ws://10.0.0.1:9473/ws";
        let after = "ws://10.0.0.2:9473/ws";
        write_hub_config(&config_dir, before);

        let cfg = WatchConfig {
            vault_path: vault.clone(),
            db_path: db_path.clone(),
            config_dir: config_dir.clone(),
            pid_file: tmp.path().join("watch.pid"),
            sync_interval: Duration::from_millis(150),
            librarian_script: None,
        };
        let task = tokio::spawn(async move { run_watch_async(cfg).await });

        assert!(
            wait_for_detail(&config_dir, "10.0.0.1").await,
            "precondition: the daemon must actually be using the pre-rewrite hub, or the \
             assertion below passes against a daemon that never synced. detail was {:?}",
            last_detail(&config_dir)
        );

        write_hub_config(&config_dir, after);

        let took_it_up = wait_for_detail(&config_dir, "10.0.0.2").await;
        task.abort();
        assert!(
            took_it_up,
            "the daemon went on using the config it read at startup; detail was {:?}",
            last_detail(&config_dir)
        );
    }

    // --- the reload decision, without a daemon ---------------------------
    //
    // Deterministic: no timing, no reindex, no sockets. The e2e test above
    // proves the tick CALLS this; these three prove what it decides.

    #[test]
    fn a_rewritten_config_is_taken_up() {
        let tmp = tempfile::tempdir().unwrap();
        write_hub_config(tmp.path(), "wss://before.invalid/ws");
        let first = reload_federation_config(tmp.path(), None).unwrap();
        assert_eq!(first.hub.endpoint, "wss://before.invalid/ws");

        write_hub_config(tmp.path(), "wss://after.invalid/ws");
        let second = reload_federation_config(tmp.path(), Some(first)).unwrap();
        assert_eq!(second.hub.endpoint, "wss://after.invalid/ws");
    }

    #[test]
    fn a_config_that_stops_parsing_leaves_the_last_good_one_in_force() {
        let tmp = tempfile::tempdir().unwrap();
        write_hub_config(tmp.path(), "wss://good.invalid/ws");
        let good = reload_federation_config(tmp.path(), None).unwrap();

        std::fs::write(crate::sync::config::config_path(tmp.path()), "{ not json").unwrap();
        let kept = reload_federation_config(tmp.path(), Some(good))
            .expect("a half-written save must not cost a working daemon its federation");
        assert_eq!(kept.hub.endpoint, "wss://good.invalid/ws");
    }

    /// The first-join case: the daemon started before there was anything to
    /// read, so it holds `None` and must pick the file up when it appears.
    #[test]
    fn a_config_that_appears_after_startup_is_picked_up() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(
            reload_federation_config(tmp.path(), None).is_none(),
            "precondition: nothing to read yet"
        );
        write_hub_config(tmp.path(), "wss://joined.invalid/ws");
        let now = reload_federation_config(tmp.path(), None)
            .expect("a daemon that started before `join` must still take the config up");
        assert_eq!(now.hub.endpoint, "wss://joined.invalid/ws");
    }

}
