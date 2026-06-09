import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHarvested, filterUnharvested, appendHarvested } from "../scripts/harvest-dedup.mjs";

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
