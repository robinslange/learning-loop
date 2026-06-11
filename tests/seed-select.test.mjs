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
    mk("feedback_demo-brand_carousel.md", "feedback"),
  ];
  const { kept, dropped } = selectSeedMemories(files, {
    types: ["feedback"],
    denyNamePatterns: ["demo-brand", "dana"],
  });
  assert.deepEqual(kept.map((k) => k.name), ["feedback_clean.md"]);
  assert.equal(dropped[0].name, "feedback_demo-brand_carousel.md");
  assert.equal(dropped[0].reason, "name-denied");
});

test("name deny uses word boundaries, not substrings — 'ai' must not drop 'maintain'/'fail'", () => {
  // seed-select shares the deny semantics documented in 08-seed-restore.md and used
  // by harvest-scrub: a bare token matches on word boundaries (so `acme` blocks
  // `acme-registry` but not `acmecorp`). A substring match would wrongly drop
  // feedback_maintain.md (m-ai-n) and feedback_fail_modes.md (f-ai-l).
  const files = [
    mk("feedback_maintain.md", "feedback"),
    mk("feedback_fail_modes.md", "feedback"),
    mk("feedback_ai_research.md", "feedback"),
  ];
  const { kept, dropped } = selectSeedMemories(files, {
    types: ["feedback"],
    denyNamePatterns: ["ai"],
  });
  assert.deepEqual(
    kept.map((k) => k.name).sort(),
    ["feedback_fail_modes.md", "feedback_maintain.md"],
  );
  assert.deepEqual(dropped.map((d) => d.name), ["feedback_ai_research.md"]);
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
