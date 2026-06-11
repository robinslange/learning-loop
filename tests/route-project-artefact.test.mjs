import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeArtefact, extractProjectSlug, readVaultProjectIndexSync, listProjectSlugs } from '../plugin/scripts/route-project-artefact.mjs';

const vault = {
  projectFiles: ['acme.md', 'omit.md', 'umbrella.md', 'fabrikam.md', 'widget-co.md'],
  projectDirs: ['property-separation'],
};

test('extractProjectSlug pulls umbrella from interview prep filename', () => {
  assert.equal(extractProjectSlug('umbrella-call-brief-jenny.md', vault), 'umbrella');
});

test('extractProjectSlug pulls acme from evidence filename', () => {
  assert.equal(extractProjectSlug('acme-legal-evidence-update.md', vault), 'acme');
});

test('extractProjectSlug returns null for atomic insight title', () => {
  assert.equal(extractProjectSlug('axum-websocketupgrade-max-message-size.md', vault), null);
});

test('extractProjectSlug returns null for project not in 4-projects/', () => {
  assert.equal(extractProjectSlug('imaginary-corp-pitch.md', vault), null);
});

test('routeArtefact routes to 4-projects/<slug>/ when slug matches an existing project file', () => {
  const result = routeArtefact('umbrella-call-brief-jenny.md', vault);
  assert.equal(result.destination, '4-projects/umbrella/');
  assert.equal(result.slug, 'umbrella');
});

test('routeArtefact routes to 4-projects/<slug>/ when slug matches an existing project dir', () => {
  const result = routeArtefact('property-separation-deed-summary.md', vault);
  assert.equal(result.destination, '4-projects/property-separation/');
});

test('routeArtefact returns inbox destination for atomic notes', () => {
  const result = routeArtefact('axum-websocketupgrade-max-message-size.md', vault);
  assert.equal(result.destination, '0-inbox/');
  assert.equal(result.slug, null);
});

test('extractProjectSlug prefers longest matching slug (acme-legal > acme)', () => {
  const vaultWithBoth = {
    projectFiles: ['acme.md', 'acme-legal.md'],
    projectDirs: [],
  };
  assert.equal(extractProjectSlug('acme-legal-evidence-update.md', vaultWithBoth), 'acme-legal');
});

test('readVaultProjectIndexSync reads project files and dirs from 4-projects/', () => {
  const vault = mkdtempSync(join(tmpdir(), 'll-route-'));
  mkdirSync(join(vault, '4-projects'), { recursive: true });
  writeFileSync(join(vault, '4-projects', 'acme.md'), '# acme');
  mkdirSync(join(vault, '4-projects', 'widget-co'), { recursive: true });
  const idx = readVaultProjectIndexSync(vault);
  assert.deepEqual(idx.projectFiles.sort(), ['acme.md']);
  assert.deepEqual(idx.projectDirs.sort(), ['widget-co']);
});

test('readVaultProjectIndexSync returns empty index when 4-projects/ is absent', () => {
  const vault = mkdtempSync(join(tmpdir(), 'll-route-'));
  assert.deepEqual(readVaultProjectIndexSync(vault), { projectFiles: [], projectDirs: [] });
});

test('listProjectSlugs dedupes files and dirs, longest first', () => {
  const slugs = listProjectSlugs({ projectFiles: ['acme.md', 'acme-legal.md'], projectDirs: ['widget-co'] });
  assert.deepEqual(slugs, ['acme-legal', 'widget-co', 'acme']);
});
