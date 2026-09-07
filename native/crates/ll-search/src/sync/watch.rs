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
                reload_config(&cfg.config_dir, &mut fed_config);
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

/// Bring `held` up to date with `config.json` before a federation tick uses it.
///
/// **The file is the source of truth for which hub this vault is on, and this
/// is what keeps it that way.** The config used to be read once, before the
/// loop, and kept for the process's life. `ll join` writes that file — and it
/// is normally run inside a session that already spawned this daemon, because
/// SessionStart spawns one and only replaces it when the binary's mtime
/// changes. So the daemon went on dialling the endpoint it had read at
/// startup, and, worse, wrote *that* failure into `sync-state.json` on every
/// tick, over a successful manual sync included. `ll status` renders that
/// file, so a process nobody could see was overwriting the truth about which
/// hub this vault had joined with an error about one it had left.
///
/// Re-reading is per federation tick, not per event: one small JSON file every
/// `sync_interval`, next to a sync that opens a WebSocket and uploads an index.
///
/// **A file that does not parse keeps the last config that did.** That is the
/// reason this is not `load_config(..).ok()` assigned straight in. `write_config`
/// renames a complete file into place, so a parse failure is never a torn read
/// — it is a config someone has edited by hand into something invalid. Dropping
/// to `None` there would silently stop a daemon that had been syncing fine, and
/// silent-stop is the failure this whole function exists to remove, not one to
/// trade for. A file that has been *deleted* is different and does clear it:
/// that is an uninstall or a vault that has left, and continuing to sync on a
/// config the user removed is the one direction worse than stopping.
fn reload_config(config_dir: &Path, held: &mut Option<FederationConfig>) {
    match super::config::load_config(config_dir) {
        Ok(fresh) => *held = Some(fresh),
        Err(e) if is_not_found(&e) => *held = None,
        Err(e) => eprintln!(
            "federation config at {} did not parse ({e}); still syncing against the last \
             one that did. Fix the file — nothing here rewrites it.",
            super::config::config_path(config_dir).display()
        ),
    }
}

/// Whether an error from [`super::config::load_config`] is "no such file".
///
/// `load_config` reads and then parses, so its error is an `io::Error` for a
/// missing file and a `serde_json::Error` for a broken one. Those two need
/// opposite handling above, and the message is not what tells them apart.
fn is_not_found(e: &anyhow::Error) -> bool {
    e.downcast_ref::<std::io::Error>()
        .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
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
mod config_reload_tests {
    use super::*;
    use crate::sync::config::{self, HubEndpoint};
    use crate::sync::{seed_store, test_hub};
    use tempfile::TempDir;

    fn config_pointing_at(endpoint: &str) -> FederationConfig {
        let mut c = FederationConfig::test_fixture("private", Vec::new());
        c.hub = HubEndpoint {
            endpoint: endpoint.into(),
            key_id: Some("z6MkpZHEGuuEsage7m4TN8FXKxZr6vEkEtz9Xkf9cWuLcwE7".into()),
        };
        c.vault_id = Some("01a07e21-0d14-77d1-9dbc-cefc0bec9b25".into());
        c
    }

    fn endpoint_of(held: &Option<FederationConfig>) -> Option<&str> {
        held.as_ref().map(|c| c.hub.endpoint.as_str())
    }

    #[test]
    fn a_config_written_after_the_daemon_started_is_picked_up() {
        // The state `join` leaves behind: the daemon began with no config at
        // all, because this vault had not federated when the session started.
        let dir = TempDir::new().unwrap();
        let mut held = config::load_config(dir.path()).ok();
        assert!(held.is_none(), "precondition: nothing on disk yet");

        config::write_config(dir.path(), &config_pointing_at("wss://new.example/ws")).unwrap();
        reload_config(dir.path(), &mut held);

        assert_eq!(endpoint_of(&held), Some("wss://new.example/ws"));
    }

    #[test]
    fn a_rewritten_endpoint_replaces_the_one_the_daemon_was_holding() {
        let dir = TempDir::new().unwrap();
        config::write_config(dir.path(), &config_pointing_at("ws://100.64.0.2:9473/ws")).unwrap();
        let mut held = config::load_config(dir.path()).ok();
        assert_eq!(endpoint_of(&held), Some("ws://100.64.0.2:9473/ws"));

        config::write_config(dir.path(), &config_pointing_at("wss://hub.example:8443")).unwrap();
        reload_config(dir.path(), &mut held);

        assert_eq!(endpoint_of(&held), Some("wss://hub.example:8443"));
    }

    #[test]
    fn a_config_that_stops_parsing_keeps_the_last_one_that_did() {
        // `write_config` renames a complete file into place, so this is not a
        // torn read — it is a hand-edit. A daemon that was syncing must not be
        // stopped by it, because a daemon that stops syncing says nothing.
        let dir = TempDir::new().unwrap();
        config::write_config(dir.path(), &config_pointing_at("wss://hub.example:8443")).unwrap();
        let mut held = config::load_config(dir.path()).ok();

        std::fs::write(config::config_path(dir.path()), "{ this is not json").unwrap();
        reload_config(dir.path(), &mut held);

        assert_eq!(
            endpoint_of(&held),
            Some("wss://hub.example:8443"),
            "a broken file must not silently disable federation",
        );
    }

    #[test]
    fn a_deleted_config_does_stop_the_syncing() {
        // The one direction worse than stopping: syncing on a config the user
        // has removed. `is_not_found` is what tells this apart from the case
        // above, and the two want opposite answers.
        let dir = TempDir::new().unwrap();
        config::write_config(dir.path(), &config_pointing_at("wss://hub.example:8443")).unwrap();
        let mut held = config::load_config(dir.path()).ok();
        assert!(held.is_some());

        std::fs::remove_file(config::config_path(dir.path())).unwrap();
        reload_config(dir.path(), &mut held);

        assert!(held.is_none());
    }

    /// The property the three tests above cannot reach: that the LOOP asks.
    ///
    /// They would all pass against a daemon that reads `config.json` once and
    /// never calls `reload_config` at all — which is exactly the shipped
    /// behaviour this replaced. So this one runs the real `run_watch_async`,
    /// rewrites `config.json` underneath it, and reads back the file the
    /// daemon writes about what it did.
    ///
    /// `sync-state.json` is the observable on purpose: it is the file `ll
    /// status` renders, and the whole defect was a daemon writing a dead
    /// endpoint into it. Both endpoints here are closed loopback ports, so
    /// every cycle fails and names the endpoint it failed against — which is
    /// the only thing being asserted. No hub, no network, no TLS.
    #[tokio::test]
    async fn the_running_daemon_syncs_against_a_config_rewritten_underneath_it() {
        test_hub::force_encrypted_seed_backend();
        let home = TempDir::new().unwrap();
        let vault = TempDir::new().unwrap();
        let config_dir = home.path().to_path_buf();
        std::fs::create_dir_all(config_dir.join("federation")).unwrap();
        seed_store::write_encrypted(&config_dir, &[7u8; 32]).unwrap();

        // An empty vault indexes to a database with no `model_id`, and the
        // export refuses that before it ever reads the endpoint. Stamping one
        // is what puts the failure at the hub instead, which is where this
        // test needs to read it. `reindex` without `--force` leaves it alone.
        let db_path = vault.path().join(".vault-search").join("vault-index.db");
        crate::db::open_or_create_db(&db_path.to_string_lossy())
            .unwrap()
            .execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('model_id', ?1)",
                rusqlite::params!["test-model"],
            )
            .unwrap();

        config::write_config(&config_dir, &config_pointing_at("ws://127.0.0.1:9101/ws")).unwrap();

        let watch = tokio::spawn(run_watch_async(WatchConfig {
            vault_path: vault.path().to_path_buf(),
            db_path,
            config_dir: config_dir.clone(),
            pid_file: home.path().join("watch.pid"),
            sync_interval: Duration::from_millis(250),
            librarian_script: None,
        }));

        // Establish that the cycle runs at all and names its endpoint, or the
        // assertion after the rewrite would have nowhere to happen: a daemon
        // that never synced and a daemon that ignored the rewrite both leave
        // no mention of the second endpoint.
        assert!(
            detail_naming(&config_dir, "127.0.0.1:9101").await,
            "the daemon never recorded a cycle against the first endpoint",
        );

        config::write_config(&config_dir, &config_pointing_at("ws://127.0.0.1:9202/ws")).unwrap();

        let picked_up = detail_naming(&config_dir, "127.0.0.1:9202").await;
        watch.abort();
        assert!(
            picked_up,
            "a config rewritten under a running daemon must take effect without a restart",
        );
    }

    /// Wait for `sync-state.json` to record a failure naming `needle`.
    ///
    /// Polled rather than slept on: the deadline is generous so a loaded
    /// machine does not fail this, and a fast one does not pay for it.
    async fn detail_naming(config_dir: &Path, needle: &str) -> bool {
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if let Ok(text) = std::fs::read_to_string(
                config_dir.join("federation").join("sync-state.json"),
            ) {
                if text.contains(needle) {
                    return true;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }
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
