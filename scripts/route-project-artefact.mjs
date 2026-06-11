import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export function listProjectSlugs(vault) {
  const fromFiles = vault.projectFiles.map((f) => f.replace(/\.md$/, ''));
  const fromDirs = vault.projectDirs;
  // Sort by length DESC so longest prefix wins for nested slugs (kinso-legal > kinso)
  return [...new Set([...fromFiles, ...fromDirs])].sort((a, b) => b.length - a.length);
}

export function extractProjectSlug(filename, vault) {
  const base = filename.replace(/\.md$/, '');
  const slugs = listProjectSlugs(vault);
  for (const slug of slugs) {
    if (base === slug) return slug;
    if (base.startsWith(slug + '-')) return slug;
  }
  return null;
}

export function routeArtefact(filename, vault) {
  const slug = extractProjectSlug(filename, vault);
  if (!slug) {
    return { destination: '0-inbox/', slug: null };
  }
  return { destination: `4-projects/${slug}/`, slug };
}

export function readVaultProjectIndexSync(vaultPath) {
  const projectsDir = join(vaultPath, '4-projects');
  let entries;
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return { projectFiles: [], projectDirs: [] };
  }
  const projectFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name);
  const projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  return { projectFiles, projectDirs };
}

export async function readVaultProjectIndex(vaultPath) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const projectsDir = path.join(vaultPath, '4-projects');
  let entries;
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return { projectFiles: [], projectDirs: [] };
  }
  const projectFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name);
  const projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  return { projectFiles, projectDirs };
}
