// tests/docs-native-module-tree.test.mjs
// native/README.md draws the ll-search module tree as prose. It is not
// CLI-shaped or roster-shaped, so docs-name-real-commands and
// docs-consistency never swept it, and it drifted: the app/ module landed in
// August and the tree still described the layout from before it, along with
// four files under search/. Derive the truth from disk instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'native', 'crates', 'll-search', 'src');
const README = readFileSync(join(ROOT, 'native', 'README.md'), 'utf8');

// The tree lists a module per line as `name.rs   description` or `dir/`.
const tree = README.split('## Module Structure')[1]?.split('```')[1] ?? '';

// Test-only modules are compiled out of the shipped binary, so the tree is
// right to omit them; the README says so explicitly.
//
// The gate is the DECLARATION, not the file: nearly every shipped module ends
// with its own `#[cfg(test)] mod tests`, so grepping the target file marks the
// whole codebase test-only and the check below silently passes on everything.
// A module is test-only when its parent declares it under #[cfg(test)].
function isTestOnly(dir, file) {
  const stem = file.replace(/\.rs$/, '');
  // Both module shapes: `dir/mod.rs` (2015) and `dir.rs` beside `dir/` (2018,
  // which is what preprocess uses). Reading only the first answers "not
  // test-only" for every submodule of a 2018-shaped parent, which is the right
  // answer for the wrong reason and demands a genuinely exempt file appear in
  // the tree.
  const parent = [join(SRC, dir, 'mod.rs'), join(SRC, `${dir}.rs`)].find((p) => existsSync(p));
  if (!parent) return false;
  const decl = readFileSync(parent, 'utf8');
  return new RegExp(`#\\[cfg\\(test\\)\\]\\s*(?:pub(?:\\([^)]*\\))?\\s+)?mod\\s+${stem}\\s*;`).test(
    decl,
  );
}

test('every source directory under src/ appears in the module tree', () => {
  const dirs = readdirSync(SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  for (const dir of dirs) {
    assert.ok(tree.includes(`${dir}/`), `native/README.md module tree omits src/${dir}/`);
  }
});

test('every file in an expanded module appears in the tree', () => {
  // A directory the tree expands (lists children for) must list all of them:
  // a half-listed module reads as complete and is how search/ lost four files.
  // preprocess/ is the Rust 2018 shape: preprocess.rs beside a preprocess/
  // holding its submodules, so the tree has to show both.
  for (const dir of ['app', 'db', 'search', 'preprocess']) {
    const files = readdirSync(join(SRC, dir))
      .filter((f) => f.endsWith('.rs') && f !== 'mod.rs')
      .filter((f) => !isTestOnly(dir, f));
    for (const f of files) {
      assert.ok(tree.includes(f), `native/README.md module tree omits src/${dir}/${f}`);
    }
  }
});
