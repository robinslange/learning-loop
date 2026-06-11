import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { listVaultNotes } from "../plugin/scripts/lib/vault-walk.mjs";

test("walks .md recursively, excludes _archive/_archived/Excalidraw and dotdirs", () => {
  const v = join(tmpdir(), `ll-vault-${randomBytes(8).toString("hex")}`);
  mkdirSync(join(v, "3-permanent"), { recursive: true });
  mkdirSync(join(v, "_archive"), { recursive: true });
  mkdirSync(join(v, "Excalidraw"), { recursive: true });
  mkdirSync(join(v, ".obsidian"), { recursive: true });
  writeFileSync(join(v, "3-permanent", "a.md"), "x");
  writeFileSync(join(v, "_archive", "old.md"), "x");
  writeFileSync(join(v, "Excalidraw", "d.excalidraw.md"), "x");
  writeFileSync(join(v, ".obsidian", "cfg.md"), "x");
  writeFileSync(join(v, "top.md"), "x");

  const rel = listVaultNotes(v).map((n) => n.path.slice(v.length + 1)).sort();
  rmSync(v, { recursive: true, force: true });
  assert.deepEqual(rel, ["3-permanent/a.md", "top.md"]);
});
