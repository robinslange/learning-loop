import test from "node:test";
import assert from "node:assert/strict";
import { selectSeedMemories } from "../scripts/seed-select.mjs";

const mk = (name, type, extra = "") => ({
  name,
  text: `---\nname: ${name}\ntype: ${type}\n---\n${extra}body`,
});

test("keeps only requested types", () => {
  const files = [
    mk("feedback_a.md", "feedback"),
    mk("project_b.md", "project"),
    mk("reference_c.md", "reference"),
  ];
  const { kept, dropped } = selectSeedMemories(files, {
    types: ["feedback"],
    denyNamePatterns: [],
  });
  assert.deepEqual(kept.map((k) => k.name), ["feedback_a.md"]);
  assert.equal(dropped.length, 2);
  assert.ok(dropped.every((d) => d.reason === "type-excluded"));
});

test("name deny-list drops project-flavored feedback even when type matches", () => {
  const files = [
    mk("feedback_clean.md", "feedback"),
    mk("feedback_strom_carousel.md", "feedback"),
  ];
  const { kept, dropped } = selectSeedMemories(files, {
    types: ["feedback"],
    denyNamePatterns: ["strom", "ella"],
  });
  assert.deepEqual(kept.map((k) => k.name), ["feedback_clean.md"]);
  assert.equal(dropped[0].name, "feedback_strom_carousel.md");
  assert.equal(dropped[0].reason, "name-denied");
});

test("missing type frontmatter is excluded, not crashed", () => {
  const files = [{ name: "weird.md", text: "no frontmatter here" }];
  const { kept, dropped } = selectSeedMemories(files, {
    types: ["feedback"],
    denyNamePatterns: [],
  });
  assert.equal(kept.length, 0);
  assert.equal(dropped[0].reason, "type-excluded");
});
