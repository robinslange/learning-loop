// plugin/scripts/lib/secret.mjs : shared Keychain lookup helper.
//
// resolveSecret(ref, { keyResolver }) is the single surface for reading secrets
// by service-name ref (macOS Keychain account=$USER). Default keyResolver calls
// `security find-generic-password`; tests inject a stub to stay OS-independent.
import { execFileSync } from 'node:child_process';

function keychainKey(ref) {
  return execFileSync(
    'security',
    ['find-generic-password', '-a', process.env.USER, '-s', ref, '-w'],
    { encoding: 'utf-8', timeout: 5000 },
  );
}

/** Resolve a secret by reference. Null on any failure or falsy ref. */
export function resolveSecret(ref, { keyResolver = keychainKey } = {}) {
  if (!ref) return null;
  try {
    return keyResolver(ref).trim();
  } catch {
    return null;
  }
}
