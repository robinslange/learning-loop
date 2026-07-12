// scripts/lib/vault-walk.mjs : recursively list vault note files.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXCLUDE_DIRS = new Set(['_archive', '_archived', 'Excalidraw']);

/**
 * @param {string} vaultPath
 * @param {{ dirs?: string[] }} [opts]  `dirs` restricts the walk to these
 *   top-level folders (an explicit allowlist); missing folders are skipped.
 *   Default walks the whole vault. EXCLUDE_DIRS and dot-dirs are skipped at
 *   every depth either way.
 * @returns {{ path: string }[]}  absolute paths to .md notes
 */
export function listVaultNotes(vaultPath, { dirs } = {}) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || EXCLUDE_DIRS.has(e.name)) continue;
        walk(join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push({ path: join(dir, e.name) });
      }
    }
  };
  if (dirs) {
    for (const d of dirs) walk(join(vaultPath, d));
  } else {
    walk(vaultPath);
  }
  return out;
}

/** Read note text. */
export function readNote(path) {
  return readFileSync(path, 'utf8');
}
