import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubNotes } from "../scripts/harvest-scrub.mjs";

test("deny-list hit blocks on word boundary (case-insensitive)", () => {
  const notes = [
    { path: "ok.md", text: "a generic lesson about retries" },
    { path: "leak.md", text: "the NRD registry pattern we used at fostermoore today" },
  ];
  const { blocked, clean } = scrubNotes(notes, {
    denylist: ["fostermoore", "nrd"],
    tripwirePatterns: [],
  });
  assert.deepEqual(blocked.map((b) => b.path), ["leak.md"]);
  assert.equal(blocked[0].hits.map((h) => h.toLowerCase()).sort().join(","), "fostermoore,nrd");
  assert.deepEqual(clean.map((c) => c.path), ["ok.md"]);
});

test("word-boundary: short term does not match inside a larger word", () => {
  const notes = [
    { path: "innocent.md", text: "the maintainer fixed a domain bug in the container" },
    { path: "real.md", text: "this is about AI specifically" },
  ];
  const { blocked, clean } = scrubNotes(notes, {
    denylist: ["ai"],
    tripwirePatterns: [],
  });
  assert.deepEqual(blocked.map((b) => b.path), ["real.md"]);
  assert.deepEqual(clean.map((c) => c.path), ["innocent.md"]);
});

test("deny term with regex metacharacters is matched literally", () => {
  const notes = [{ path: "x.md", text: "contact me at bob@foster.co.nz please" }];
  const { blocked } = scrubNotes(notes, {
    denylist: ["foster.co.nz"],
    tripwirePatterns: [],
  });
  assert.deepEqual(blocked.map((b) => b.path), ["x.md"]);
});

test("tripwire flags but does not block", () => {
  const notes = [{ path: "maybe.md", text: "see https://internal.example/doc" }];
  const { blocked, tripwire, clean } = scrubNotes(notes, {
    denylist: [],
    tripwirePatterns: ["https?://\\S+"],
  });
  assert.equal(blocked.length, 0);
  assert.deepEqual(tripwire.map((t) => t.path), ["maybe.md"]);
  assert.deepEqual(clean.map((c) => c.path), ["maybe.md"]);
});

test("a note both denied and tripwired is blocked (block wins)", () => {
  const notes = [{ path: "bad.md", text: "NRD at https://x" }];
  const { blocked, clean } = scrubNotes(notes, {
    denylist: ["nrd"],
    tripwirePatterns: ["https?://\\S+"],
  });
  assert.deepEqual(blocked.map((b) => b.path), ["bad.md"]);
  assert.equal(clean.length, 0);
});

test("derived instance facts block even with an empty hand-listed denylist", () => {
  const notes = [{ path: "leak.md", text: "ref ed25519:OWNKEY and peer thomas" }];
  const { blocked, clean } = scrubNotes(notes, {
    denylist: ["thomas", "ed25519:OWNKEY"],
    tripwirePatterns: [],
  });
  assert.deepEqual(blocked.map((b) => b.path), ["leak.md"]);
  assert.equal(clean.length, 0);
});

test("CLI reads note paths from stdin when no path args given", () => {
  const dir = mkdtempSync(join(tmpdir(), "ll-scrub-cli-"));
  try {
    const ok = join(dir, "ok.md");
    const leak = join(dir, "leak.md");
    const deny = join(dir, "deny.txt");
    writeFileSync(ok, "a generic retry lesson");
    writeFileSync(leak, "we used NRD at work");
    writeFileSync(deny, "nrd\n");
    const scrubScript = new URL("../scripts/harvest-scrub.mjs", import.meta.url).pathname;
    const out = execFileSync(
      process.execPath,
      [scrubScript, deny, ""],            // empty pluginData => no derived facts
      { input: `${ok}\n${leak}\n`, encoding: "utf8" },
    );
    const result = JSON.parse(out);
    assert.deepEqual(result.blocked.map((b) => b.path), [leak]);
    assert.deepEqual(result.clean.map((c) => c.path), [ok]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
