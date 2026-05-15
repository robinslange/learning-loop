import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeArtefact, extractProjectSlug } from '../scripts/route-project-artefact.mjs';

const vault = {
  projectFiles: ['kinso.md', 'omit.md', 'foster-moore.md', 'halter.md', 'solenoid-systems.md'],
  projectDirs: ['property-separation'],
};

test('extractProjectSlug pulls foster-moore from interview prep filename', () => {
  assert.equal(extractProjectSlug('foster-moore-call-brief-jenny.md', vault), 'foster-moore');
});

test('extractProjectSlug pulls kinso from evidence filename', () => {
  assert.equal(extractProjectSlug('kinso-legal-evidence-update.md', vault), 'kinso');
});

test('extractProjectSlug returns null for atomic insight title', () => {
  assert.equal(extractProjectSlug('axum-websocketupgrade-max-message-size.md', vault), null);
});

test('extractProjectSlug returns null for project not in 4-projects/', () => {
  assert.equal(extractProjectSlug('imaginary-corp-pitch.md', vault), null);
});

test('routeArtefact routes to 4-projects/<slug>/ when slug matches an existing project file', () => {
  const result = routeArtefact('foster-moore-call-brief-jenny.md', vault);
  assert.equal(result.destination, '4-projects/foster-moore/');
  assert.equal(result.slug, 'foster-moore');
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

test('extractProjectSlug prefers longest matching slug (kinso-legal > kinso)', () => {
  const vaultWithBoth = {
    projectFiles: ['kinso.md', 'kinso-legal.md'],
    projectDirs: [],
  };
  assert.equal(extractProjectSlug('kinso-legal-evidence-update.md', vaultWithBoth), 'kinso-legal');
});
