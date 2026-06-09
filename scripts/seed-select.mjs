// scripts/seed-select.mjs : mechanical selection of memory files for a seed bundle.
// Keep by frontmatter `type`; drop by filename deny pattern. Pure + CLI.
// Deny patterns match on word boundaries via the shared matcher (the same
// semantics harvest uses, documented in init phase 08): "ai" drops
// "feedback_ai_research.md" but not "feedback_maintain.md".
import { parseFrontmatter } from './lib/markdown-parse.mjs';
import { denyTermMatches } from './lib/deny-match.mjs';

/**
 * @param {{name: string, text: string}[]} files
 * @param {{types: string[], denyNamePatterns: string[]}} opts
 * @returns {{kept: {name:string,text:string}[], dropped: {name:string,reason:string}[]}}
 */
export function selectSeedMemories(files, opts) {
  const types = new Set(opts.types || []);
  const deny = (opts.denyNamePatterns || []).filter((p) => typeof p === 'string' && p.trim());
  const kept = [];
  const dropped = [];
  for (const file of files) {
    const denied = deny.find((p) => denyTermMatches(p, file.name));
    if (denied) {
      dropped.push({ name: file.name, reason: 'name-denied' });
      continue;
    }
    const { fm } = parseFrontmatter(file.text);
    if (!fm.type || !types.has(fm.type)) {
      dropped.push({ name: file.name, reason: 'type-excluded' });
      continue;
    }
    kept.push(file);
  }
  return { kept, dropped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // CLI: seed-select.mjs <memDir> <comma-types> [comma-deny]
  const { listMemoryFiles, readMemoryFile } = await import('./lib/memory-paths.mjs');
  const [memDir, typesArg, denyArg] = process.argv.slice(2);
  if (!memDir) {
    console.error('Usage: seed-select.mjs <memDir> <types> [denyPatterns]');
    process.exit(2);
  }
  const files = listMemoryFiles(memDir).map((f) => ({
    name: f.name,
    text: readMemoryFile(f.path),
  }));
  const result = selectSeedMemories(files, {
    types: (typesArg || 'feedback').split(',').map((s) => s.trim()).filter(Boolean),
    denyNamePatterns: (denyArg || '').split(',').map((s) => s.trim()).filter(Boolean),
  });
  console.log(JSON.stringify(
    { kept: result.kept.map((k) => k.name), dropped: result.dropped },
    null, 2,
  ));
}
