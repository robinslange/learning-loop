import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { listMemoryFiles, resolveMemoryDir } from "../scripts/lib/memory-paths.mjs";

test("resolveMemoryDir encodes the project dir like dream-gate does", () => {
  const dir = resolveMemoryDir("/Users/robin/brain", "/home/x");
  assert.equal(dir, "/home/x/.claude/projects/-Users-robin-brain/memory");
});

test("resolveMemoryDir returns null when project dir is absent", () => {
  assert.equal(resolveMemoryDir(undefined, "/home/x"), null);
});

test("listMemoryFiles returns .md files in a memory dir, excludes MEMORY.md and subdirs", () => {
  const root = join(tmpdir(), `ll-mem-${randomBytes(8).toString("hex")}`);
  const memDir = join(root, "memory");
  mkdirSync(join(memDir, "_archived"), { recursive: true });
  writeFileSync(join(memDir, "feedback_a.md"), "x");
  writeFileSync(join(memDir, "project_b.md"), "x");
  writeFileSync(join(memDir, "MEMORY.md"), "index");
  writeFileSync(join(memDir, "_dream_log.md"), "log");
  writeFileSync(join(memDir, "_archived", "old.md"), "x");

  const files = listMemoryFiles(memDir).map((f) => f.name).sort();
  rmSync(root, { recursive: true, force: true });

  assert.deepEqual(files, ["feedback_a.md", "project_b.md"]);
});
