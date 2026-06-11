// scripts/harvest-collect.mjs : the harvest whitelist gate.
// Keep ONLY notes with frontmatter `portable: true`. Never consult `visibility`.
// Default-absent = excluded. Mechanical, fails closed.
import { parseFrontmatter } from './lib/markdown-parse.mjs';

/**
 * @param {{path: string, text: string}[]} notes
 * @returns {{path: string, text: string}[]}
 */
export function collectPortable(notes) {
  return notes.filter((n) => {
    const { fm } = parseFrontmatter(n.text);
    return fm.portable === 'true';
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // CLI: harvest-collect.mjs <vaultDir> <memDir>  -> prints kept paths.
  // Takes DIRECTORIES and walks them internally — never receives a path list
  // through argv (a ~600-note vault would blow argv limits).
  const { readFileSync } = await import('node:fs');
  const { listVaultNotes } = await import('./lib/vault-walk.mjs');
  const { listMemoryFiles } = await import('./lib/memory-paths.mjs');
  const [vaultDir, memDir] = process.argv.slice(2);
  const paths = [
    ...(vaultDir ? listVaultNotes(vaultDir).map((n) => n.path) : []),
    ...(memDir ? listMemoryFiles(memDir).map((f) => f.path) : []),
  ];
  const notes = paths.map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));
  for (const n of collectPortable(notes)) console.log(n.path);
}
