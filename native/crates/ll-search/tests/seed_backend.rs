use ll_search::sync::seed_store::{
    load_or_create, read_encrypted, read_plaintext_legacy, write_encrypted, SeedBackend,
};
use ll_search::sync::config::{encrypted_seed_path, seed_path};
use tempfile::tempdir;

/// RAII guard that removes LL_SEED_BACKEND on drop, even if the test panics.
struct BackendGuard;
impl Drop for BackendGuard {
    fn drop(&mut self) {
        std::env::remove_var("LL_SEED_BACKEND");
    }
}

#[test]
fn encrypted_roundtrip_returns_same_seed() {
    let tmp = tempdir().unwrap();
    let seed = [42u8; 32];
    write_encrypted(tmp.path(), &seed).unwrap();
    let read = read_encrypted(tmp.path()).unwrap().unwrap();
    assert_eq!(read, seed);
}

#[test]
fn encrypted_file_layout_v1_magic() {
    let tmp = tempdir().unwrap();
    write_encrypted(tmp.path(), &[7u8; 32]).unwrap();
    let path = encrypted_seed_path(tmp.path());
    let data = std::fs::read(&path).unwrap();
    assert_eq!(data.len(), 64, "total file length must be 64 bytes");
    assert_eq!(&data[..4], b"LLS1", "first 4 bytes must be LLS1 magic");
}

#[test]
fn encrypted_tampered_ciphertext_fails_decrypt() {
    let tmp = tempdir().unwrap();
    write_encrypted(tmp.path(), &[9u8; 32]).unwrap();
    let path = encrypted_seed_path(tmp.path());
    let mut data = std::fs::read(&path).unwrap();
    data[20] ^= 0xFF;
    std::fs::write(&path, &data).unwrap();
    assert!(
        read_encrypted(tmp.path()).is_err(),
        "tampered ciphertext must fail decryption"
    );
}

#[test]
fn legacy_plaintext_read_returns_correct_bytes() {
    let tmp = tempdir().unwrap();
    let fed = tmp.path().join("federation");
    std::fs::create_dir_all(&fed).unwrap();
    let legacy_path = fed.join(".seed");
    std::fs::write(&legacy_path, [5u8; 32]).unwrap();

    let result = read_plaintext_legacy(tmp.path()).unwrap().unwrap();
    assert_eq!(result, [5u8; 32]);
    assert!(seed_path(tmp.path()).exists(), "legacy seed file must still exist after read");
}

#[test]
fn env_force_encrypted_skips_keyring() {
    let tmp = tempdir().unwrap();
    std::env::set_var("LL_SEED_BACKEND", "encrypted");
    let _guard = BackendGuard;

    let result = load_or_create(tmp.path()).unwrap();
    assert_eq!(result.backend, SeedBackend::Encrypted);
}

#[test]
fn env_force_encrypted_second_load_is_not_created() {
    let tmp = tempdir().unwrap();
    std::env::set_var("LL_SEED_BACKEND", "encrypted");
    let _guard = BackendGuard;

    let r1 = load_or_create(tmp.path()).unwrap();
    assert!(r1.created);
    assert_eq!(r1.backend, SeedBackend::Encrypted);

    let r2 = load_or_create(tmp.path()).unwrap();
    assert!(!r2.created);
}

#[test]
fn env_force_encrypted_consistent_key_across_loads() {
    let tmp = tempdir().unwrap();
    std::env::set_var("LL_SEED_BACKEND", "encrypted");
    let _guard = BackendGuard;

    let r1 = load_or_create(tmp.path()).unwrap();
    let r2 = load_or_create(tmp.path()).unwrap();

    let pk1 = ll_search::sync::auth::pubkey_b64(&r1.signing_key);
    let pk2 = ll_search::sync::auth::pubkey_b64(&r2.signing_key);
    assert_eq!(pk1, pk2, "same key must be returned on repeated loads");
}

#[test]
#[ignore] // requires real secret-service or Keychain running
fn keyring_roundtrip_when_available() {
    use ll_search::sync::seed_store::{delete_keyring, read_keyring, write_keyring};
    let seed = [11u8; 32];
    write_keyring(&seed).unwrap();
    let read = read_keyring().unwrap().unwrap();
    assert_eq!(read, seed);
    delete_keyring().unwrap();
}
