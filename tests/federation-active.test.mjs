import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFederationActive } from "../scripts/federation-active.mjs";

test("true only when federation/config.json exists and parses with an identity", () => {
  const pd = mkdtempSync(join(tmpdir(), "ll-fed-"));
  try {
    assert.equal(isFederationActive(pd), false); // no file

    mkdirSync(join(pd, "federation"), { recursive: true });
    writeFileSync(join(pd, "federation", "config.json"), "not json");
    assert.equal(isFederationActive(pd), false); // unparseable

    writeFileSync(join(pd, "federation", "config.json"), JSON.stringify({}));
    assert.equal(isFederationActive(pd), false); // no identity

    writeFileSync(
      join(pd, "federation", "config.json"),
      JSON.stringify({ identity: { pubkey: "ed25519:abc" } }),
    );
    assert.equal(isFederationActive(pd), true);
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});
