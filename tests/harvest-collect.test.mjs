import test from "node:test";
import assert from "node:assert/strict";
import { collectPortable } from "../scripts/harvest-collect.mjs";

test("keeps only portable: true; ignores visibility entirely", () => {
  const notes = [
    { path: "a.md", text: "---\nportable: true\n---\nkeep" },
    { path: "b.md", text: "---\nvisibility: public\n---\ndrop (shared, not portable)" },
    { path: "c.md", text: "---\nportable: true\nvisibility: public\n---\nkeep" },
    { path: "d.md", text: "---\nportable: false\n---\ndrop" },
    { path: "e.md", text: "no frontmatter, drop" },
  ];
  const kept = collectPortable(notes).map((n) => n.path).sort();
  assert.deepEqual(kept, ["a.md", "c.md"]);
});

test("portable must be exactly true; truthy-looking strings do not count", () => {
  const notes = [
    { path: "x.md", text: "---\nportable: yes\n---\nx" },
    { path: "y.md", text: "---\nportable: True\n---\ny" },
  ];
  assert.equal(collectPortable(notes).length, 0);
});
