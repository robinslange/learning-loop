//! One implementation of "replace this JSON file", and one of "hold it still
//! while a caller reads it, changes it and writes it back".
//!
//! There were two of the first in this crate, both writing into `federation/`
//! with the same two concurrent writers — `ll link approve` and the watch
//! daemon. `state.rs` gave every write a temp name of its own; `link.rs` used
//! a fixed `.json.tmp`, so the two writers took turns clobbering each other's
//! half-written file. Measured on the grant store: 120 grants written, 60 on
//! disk. Two shapes of one thing is how that happens, so there is one shape
//! here and callers do not get to choose.
//!
//! **The temp name was the smaller half.** A whole-file read-modify-write
//! loses updates with perfect temp names — two writers each read 60, each
//! append one, each write 61, and one of the two appends is gone. So a caller
//! whose write depends on what it just read holds a [`FileLock`] across both,
//! and a unique temp name is only what stops a *reader* seeing a torn file.

use std::ffi::OsString;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use anyhow::Context;
use serde::Serialize;

/// Sequence number for temp filenames. With the pid it makes every write's
/// temp path unique, so a manual `ll sync` and the watch daemon writing at
/// the same moment cannot land on each other's half-written file.
static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

/// `name` appended to `path`'s filename, so `grants.json` yields
/// `grants.json.lock` rather than `grants.lock`. `with_extension` replaces
/// the extension it finds, which is fine for a path whose extension is known
/// and wrong for a helper that takes any path.
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().map(OsString::from).unwrap_or_default();
    name.push(".");
    name.push(suffix);
    path.with_file_name(name)
}

fn parent_of(path: &Path) -> anyhow::Result<&Path> {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| anyhow::anyhow!("{} has no parent directory", path.display()))
}

/// Write `value` as pretty JSON to a uniquely named sibling and rename it
/// over `path`, creating the parent directory if it is not there yet.
///
/// What that buys is exactly `rename(2)`'s guarantee — within one filesystem
/// a reader sees either the whole old file or the whole new one — plus the
/// certainty that two writers are never using the same temp path. What it
/// does not buy is a tested crash window: nothing here exercises a kill
/// between the write and the rename, and the safety of that gap is the
/// filesystem's promise, not ours.
pub fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> anyhow::Result<()> {
    let parent = parent_of(path)?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("creating {}", parent.display()))?;

    let tmp = sibling(
        path,
        &format!("{}.{}.tmp", std::process::id(), WRITE_SEQ.fetch_add(1, Ordering::Relaxed)),
    );
    let json = serde_json::to_vec_pretty(value)?;
    std::fs::write(&tmp, &json).with_context(|| format!("writing {}", tmp.display()))?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e).with_context(|| format!("renaming {} into place", tmp.display()));
    }
    Ok(())
}

/// How long to keep trying before giving up and saying so. Longer than any
/// holder's critical section — every one of them is a small file read, a
/// vector edit and a write — and short enough that a wedged machine reports
/// rather than hangs.
const WAIT: Duration = Duration::from_secs(10);
/// How long to sleep between attempts.
const POLL: Duration = Duration::from_millis(2);
/// A lock file this old is treated as abandoned. Only a process killed
/// between taking the lock and dropping it can leave one behind, and the
/// alternative to breaking it is a store no later run can ever write.
const STALE: Duration = Duration::from_secs(60);

/// An exclusive lock over one path, held for as long as the value lives.
///
/// `create_new` is the whole mechanism: an exclusive create is atomic on
/// every filesystem this runs on, and exactly one racer gets `Ok` while the
/// rest get `AlreadyExists`. It is advisory — it stops the writers that ask
/// for it, and nothing else — which is enough here because every writer of
/// these files is in this crate.
pub struct FileLock {
    path: PathBuf,
}

impl FileLock {
    /// Take the lock guarding `target`, waiting for whoever holds it.
    pub fn acquire(target: &Path) -> anyhow::Result<FileLock> {
        let path = sibling(target, "lock");
        let parent = parent_of(&path)?;
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;

        let deadline = Instant::now() + WAIT;
        loop {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut f) => {
                    // Who to name if this one is ever found abandoned.
                    let _ = writeln!(f, "{}", std::process::id());
                    return Ok(FileLock { path });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if is_stale(&path) {
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }
                    if Instant::now() >= deadline {
                        anyhow::bail!(
                            "waited {}s for {} and it is still held; another `ll` process \
                             is stuck. Nothing was written.",
                            WAIT.as_secs(),
                            path.display()
                        );
                    }
                    std::thread::sleep(POLL);
                }
                Err(e) => {
                    return Err(e).with_context(|| format!("taking {}", path.display()))
                }
            }
        }
    }
}

fn is_stale(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .is_some_and(|modified| abandoned(modified, SystemTime::now()))
}

/// A lock last touched at `modified` is abandoned as of `now`.
///
/// Split out from the filesystem so the decision can be asserted on without
/// backdating a real file's mtime, which std cannot do.
fn abandoned(modified: SystemTime, now: SystemTime) -> bool {
    now.duration_since(modified).is_ok_and(|age| age > STALE)
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_write_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("thing.json");
        write_json(&path, &vec![1, 2, 3]).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap().replace([' ', '\n'], ""), "[1,2,3]");
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .filter(|n| n.to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "a finished write left {leftovers:?} behind");
    }

    /// The property the fixed `.json.tmp` did not have: two writes in flight
    /// at once are never using the same temp path.
    #[test]
    fn two_writes_never_share_a_temp_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("thing.json");
        let a = sibling(&path, &format!("{}.{}.tmp", std::process::id(), 0));
        let b = sibling(&path, &format!("{}.{}.tmp", std::process::id(), 1));
        assert_ne!(a, b);
        assert!(
            a.file_name().unwrap().to_string_lossy().starts_with("thing.json."),
            "the temp name must sit beside the target, not replace its extension"
        );
    }

    #[test]
    fn the_lock_is_exclusive_and_released_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("thing.json");
        let lock = FileLock::acquire(&path).unwrap();
        assert!(sibling(&path, "lock").exists());

        // A second acquire cannot succeed while the first is held. Taking it
        // on a thread and finding it still running is the only honest way to
        // say "it blocked" without waiting out the whole timeout.
        let taken = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (p, t) = (path.clone(), taken.clone());
        let waiter = std::thread::spawn(move || {
            let _second = FileLock::acquire(&p).unwrap();
            t.store(true, Ordering::SeqCst);
        });
        std::thread::sleep(Duration::from_millis(50));
        assert!(!taken.load(Ordering::SeqCst), "two holders at once");

        drop(lock);
        waiter.join().unwrap();
        assert!(taken.load(Ordering::SeqCst), "the lock was not released on drop");
        assert!(!sibling(&path, "lock").exists(), "a released lock left its file behind");
    }

    /// A process killed while holding the lock must not lock the store for
    /// good. The alternative to breaking an abandoned lock is a file no later
    /// run can ever write.
    #[test]
    fn a_lock_older_than_any_critical_section_is_abandoned() {
        let now = SystemTime::now();
        assert!(abandoned(now - STALE - Duration::from_secs(1), now));
        assert!(!abandoned(now - Duration::from_secs(1), now), "a live holder is not abandoned");
        // A lock file whose mtime is in the future — a clock step, or a
        // filesystem with a coarser clock than ours — is a lock we know
        // nothing about, and guessing "abandoned" would break a live one.
        assert!(!abandoned(now + Duration::from_secs(600), now));
    }
}
