use ll_search::sync::config::{encrypted_seed_path, seed_meta_path, seed_path};
use ll_search::sync::seed_migrate::{migrate, migrate_rollback};
use ll_search::sync::seed_store::SeedBackend;
use tempfile::tempdir;

fn write_plaintext_seed(config_dir: &std::path::Path, seed: [u8; 32]) {
    let fed = config_dir.join("federation");
    std::fs::create_dir_all(&fed).unwrap();
    std::fs::write(fed.join(".seed"), seed).unwrap();
}

/// RAII guard that removes LL_SEED_BACKEND on drop, even if the test panics.
struct BackendGuard;
impl Drop for BackendGuard {
    fn drop(&mut self) {
        std::env::remove_var("LL_SEED_BACKEND");
    }
}

#[test]
fn migration_legacy_to_encrypted_removes_plaintext() {
    let tmp = tempdir().unwrap();
    write_plaintext_seed(tmp.path(), [3u8; 32]);
    std::env::set_var("LL_SEED_BACKEND", "encrypted");
    let _guard = BackendGuard;

    let result = migrate(tmp.path()).unwrap();

    assert!(!result.already_migrated);
    assert!(result.plaintext_removed);
    assert_eq!(result.to, SeedBackend::Encrypted);

    let plaintext = seed_path(tmp.path());
    assert!(!plaintext.exists(), "plaintext must be gone after migration");

    let enc = encrypted_seed_path(tmp.path());
    assert!(enc.exists(), "encrypted file must exist after migration");
}

#[test]
fn migration_idempotent_second_run_no_op() {
    let tmp = tempdir().unwrap();
    write_plaintext_seed(tmp.path(), [4u8; 32]);
    std::env::set_var("LL_SEED_BACKEND", "encrypted");
    let _guard = BackendGuard;

    let r1 = migrate(tmp.path()).unwrap();
    assert!(!r1.already_migrated);

    let r2 = migrate(tmp.path()).unwrap();
    assert!(r2.already_migrated, "second run must be a no-op");
}

#[test]
fn migration_meta_file_records_backend_and_timestamp() {
    let tmp = tempdir().unwrap();
    write_plaintext_seed(tmp.path(), [6u8; 32]);
    std::env::set_var("LL_SEED_BACKEND", "encrypted");
    let _guard = BackendGuard;

    migrate(tmp.path()).unwrap();

    let meta_path = seed_meta_path(tmp.path());
    assert!(meta_path.exists(), "seed-meta.json must exist after migration");
    let txt = std::fs::read_to_string(&meta_path).unwrap();
    let v: serde_json::Value = serde_json::from_str(&txt).unwrap();
    assert_eq!(v["backend"].as_str(), Some("encrypted"), "backend must be recorded");
    assert!(v["migrated_at"].as_str().is_some(), "migrated_at must be present");
}

#[test]
fn migration_signing_key_unchanged_across_migration() {
    let tmp = tempdir().unwrap();
    let original_seed = [5u8; 32];
    write_plaintext_seed(tmp.path(), original_seed);

    use ed25519_dalek::{Signer, SigningKey};
    let original_key = SigningKey::from_bytes(&original_seed);
    let message = b"test-message-for-2K-migration";
    let original_sig = original_key.sign(message);

    std::env::set_var("LL_SEED_BACKEND", "encrypted");
    let _guard = BackendGuard;

    migrate(tmp.path()).unwrap();

    let result = ll_search::sync::seed_store::load_or_create(tmp.path()).unwrap();

    let migrated_sig = result.signing_key.sign(message);
    assert_eq!(
        original_sig.to_bytes(),
        migrated_sig.to_bytes(),
        "signing key must produce identical signatures before and after migration"
    );
}

#[test]
fn migration_rollback_restores_plaintext_and_matching_key() {
    let tmp = tempdir().unwrap();
    write_plaintext_seed(tmp.path(), [8u8; 32]);
    std::env::set_var("LL_SEED_BACKEND", "encrypted");
    let _guard = BackendGuard;

    migrate(tmp.path()).unwrap();
    assert!(!seed_path(tmp.path()).exists(), "plaintext must be gone before rollback");

    migrate_rollback(tmp.path()).unwrap();

    assert!(seed_path(tmp.path()).exists(), "plaintext must be restored after rollback");
    let bytes = std::fs::read(seed_path(tmp.path())).unwrap();
    assert_eq!(bytes.as_slice(), [8u8; 32].as_slice(), "rollback must restore original seed bytes");
}

#[test]
#[ignore] // requires real secret-service running
fn migration_legacy_to_keyring_when_available() {
    let tmp = tempdir().unwrap();
    write_plaintext_seed(tmp.path(), [7u8; 32]);
    std::env::remove_var("LL_SEED_BACKEND");
    let result = migrate(tmp.path()).unwrap();
    assert_eq!(result.to, SeedBackend::Keyring);
    assert!(result.plaintext_removed);
}
