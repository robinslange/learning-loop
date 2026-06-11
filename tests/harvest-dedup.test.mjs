import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHarvested, filterUnharvested, appendHarvested } from "../plugin/scripts/harvest-dedup.mjs";
import { existsSync } from "node:fs";

test("filters already-harvested paths; appendHarvested persists", () => {
  const dir = mkdtempSync(join(tmpdir(), "ll-dedup-"));
  const log = join(dir, ".harvested-log");
  try {
    assert.deepEqual(readHarvested(log), []);
    const first = filterUnharvested(["a.md", "b.md"], readHarvested(log), false);
    assert.deepEqual(first, ["a.md", "b.md"]);

    appendHarvested(log, ["a.md"]);
    const after = filterUnharvested(["a.md", "b.md"], readHarvested(log), false);
    assert.deepEqual(after, ["b.md"]);

    const withAll = filterUnharvested(["a.md", "b.md"], readHarvested(log), true);
    assert.deepEqual(withAll, ["a.md", "b.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendHarvested creates a missing parent dir instead of crashing (dedup never silently lost)", () => {
  // SKILL step 7 calls appendHarvested in a catch-less .then() chain. If the log's
  // parent dir is absent, an ENOENT throw would crash Node and the dedup log would
  // never be written — next harvest re-carries the same notes. Create the dir.
  const dir = mkdtempSync(join(tmpdir(), "ll-dedup-mk-"));
  const log = join(dir, "nested", "deeper", ".harvested-log");
  try {
    appendHarvested(log, ["a.md", "b.md"]);
    assert.ok(existsSync(log), "log file should have been created under a missing dir");
    assert.deepEqual(readHarvested(log), ["a.md", "b.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
