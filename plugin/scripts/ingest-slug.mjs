import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

export function computeSlug(repoPath, gitOrigin) {
  const base = basename(resolve(repoPath));
  const seed = gitOrigin || resolve(repoPath);
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 6);
  return `${base}-${hash}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repoPath = process.argv[2];
  const gitOrigin = process.argv[3] || null;
  if (!repoPath) {
    console.error('Usage: ingest-slug.mjs <repo-path> [git-origin]');
    process.exit(2);
  }
  console.log(computeSlug(repoPath, gitOrigin));
}
