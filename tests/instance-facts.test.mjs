import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveInstanceFacts } from "../scripts/lib/instance-facts.mjs";

test("derives peer ids, own pubkey, and configured email domains", () => {
  const pd = mkdtempSync(join(tmpdir(), "ll-facts-"));
  try {
    mkdirSync(join(pd, "federation", "data", "peers", "thomas"), { recursive: true });
    mkdirSync(join(pd, "federation", "data", "peers", "robin"), { recursive: true });
    writeFileSync(
      join(pd, "federation", "config.json"),
      JSON.stringify({ identity: { pubkey: "ed25519:OWNKEY" } }),
    );
    const facts = deriveInstanceFacts(pd, { email_domains: ["fostermoore.com"] });
    rmSync(pd, { recursive: true, force: true });
    const set = new Set(facts);
    assert.ok(set.has("thomas"));
    assert.ok(set.has("robin"));
    assert.ok(set.has("ed25519:OWNKEY"));
    assert.ok(set.has("fostermoore.com"));
  } catch (e) {
    rmSync(pd, { recursive: true, force: true });
    throw e;
  }
});

test("returns empty array when nothing derivable", () => {
  const pd = mkdtempSync(join(tmpdir(), "ll-facts-"));
  const facts = deriveInstanceFacts(pd, {});
  rmSync(pd, { recursive: true, force: true });
  assert.deepEqual(facts, []);
});
