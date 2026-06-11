import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

test("getConfig handles UTF-8 BOM in config.json", async (t) => {
  const data = join(tmpdir(), `ll-bom-${randomBytes(8).toString("hex")}`);
  mkdirSync(data, { recursive: true });
  t.after(() => rmSync(data, { recursive: true, force: true }));

  const bom = "﻿";
  writeFileSync(
    join(data, "config.json"),
    bom + JSON.stringify({ vault_path: "/test-vault" }),
  );

  const previousEnv = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data;
  try {
    const bust = randomBytes(4).toString("hex");
    const { getConfig } = await import(
      `../plugin/scripts/lib/config.mjs?bust=${bust}`
    );
    const config = getConfig();
    assert.equal(config.vault_path, "/test-vault");
  } finally {
    if (previousEnv === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousEnv;
  }
});
