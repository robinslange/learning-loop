import { sep, resolve, join } from 'path';
import { tmpdir, homedir } from 'os';

export function home() {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

export function tmp() {
  return tmpdir();
}

export function toForwardSlash(p) {
  return sep === '\\' ? p.replace(/\\/g, '/') : p;
}

export function relativeToVault(fullPath, vaultPath) {
  const norm = resolve(fullPath);
  const base = resolve(vaultPath);
  if (!norm.startsWith(base)) return null;
  const rel = norm.slice(base.length);
  if (rel.length === 0) return '';
  if (rel[0] === sep || rel[0] === '/') return toForwardSlash(rel.slice(1));
  return null;
}

export function expandHome(raw) {
  return resolve(raw.replace(/^~/, home()));
}

export function tmpFile(name) {
  return join(tmp(), name);
}
