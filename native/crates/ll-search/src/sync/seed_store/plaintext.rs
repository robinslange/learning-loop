//! Legacy plaintext seed: pre-2K raw 32-byte file. Read-only; used as a
//! migration source only.

use std::path::Path;

use anyhow::Context as _;

use crate::sync::config::seed_path;

/// Read the pre-2K plaintext seed file. Returns `None` if absent.
pub fn read_plaintext_legacy(config_dir: &Path) -> anyhow::Result<Option<[u8; 32]>> {
    let path = seed_path(config_dir);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path)
        .with_context(|| format!("failed to read legacy seed at {}", path.display()))?;
    let seed: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("legacy seed file must be exactly 32 bytes"))?;
    Ok(Some(seed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn legacy_plaintext_read_returns_correct_bytes() {
        let tmp = tempdir().unwrap();
        let fed = tmp.path().join("federation");
        std::fs::create_dir_all(&fed).unwrap();
        let legacy_path = fed.join(".seed");
        std::fs::write(&legacy_path, [5u8; 32]).unwrap();

        let result = read_plaintext_legacy(tmp.path()).unwrap().unwrap();
        assert_eq!(result, [5u8; 32]);
    }
}
