import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomBytes } from "node:crypto";

const runId = randomBytes(4).toString("hex");
const TEMP_ROOT = join(tmpdir(), `ll-marker-${runId}`);
const TEMP_PLUGIN_DATA = join(TEMP_ROOT, "plugin-data");
// Deliberately outside any temp dir so persistMarker treats it as "real".
// The path doesn't need to exist on disk — persistMarker only writes the
// string into the marker file.
const REAL_LIKE_PLUGIN_DATA = `/Users/ll-marker-test/${runId}/plugin-data`;

const MARKER = join(homedir(), ".claude", "plugins", "data", ".ll-data-path");

function readMarker() {
  return existsSync(MARKER) ? readFileSync(MARKER, "utf-8").trim() : null;
}

describe("plugin-data marker stomp guard", () => {
  let originalEnv;
  let originalMarker;

  before(() => {
    mkdirSync(TEMP_PLUGIN_DATA, { recursive: true });
    mkdirSync(join(homedir(), ".claude", "plugins", "data"), {
      recursive: true,
    });

    originalEnv = process.env.CLAUDE_PLUGIN_DATA;
    originalMarker = readMarker();
  });

  after(() => {
    if (originalEnv === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = originalEnv;
    if (originalMarker !== null) writeFileSync(MARKER, originalMarker, "utf-8");
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  });

  it("does not stomp the marker with a temp path", async () => {
    const sentinel = "/Users/test/sentinel-real-plugin-data";
    writeFileSync(MARKER, sentinel, "utf-8");

    process.env.CLAUDE_PLUGIN_DATA = TEMP_PLUGIN_DATA;
    const mod = await import(`../plugin/scripts/lib/config.mjs?bust=temp-${runId}`);
    const result = mod.getPluginData();

    assert.equal(result, TEMP_PLUGIN_DATA, "returns env value to caller");
    assert.equal(
      readMarker(),
      sentinel,
      "marker still holds the original real path",
    );
  });

  it("does not stomp the marker with a /var/folders path", async () => {
    const sentinel = "/Users/test/sentinel-real-plugin-data-2";
    writeFileSync(MARKER, sentinel, "utf-8");

    process.env.CLAUDE_PLUGIN_DATA = "/var/folders/abc/T/some-test/plugin-data";
    const mod = await import(
      `../plugin/scripts/lib/config.mjs?bust=varfolders-${runId}`
    );
    const result = mod.getPluginData();

    assert.equal(result, "/var/folders/abc/T/some-test/plugin-data");
    assert.equal(readMarker(), sentinel, "marker unchanged");
  });

  it("stamps the marker for a real (non-temp) env path", async () => {
    rmSync(MARKER, { force: true });

    process.env.CLAUDE_PLUGIN_DATA = REAL_LIKE_PLUGIN_DATA;
    const mod = await import(`../plugin/scripts/lib/config.mjs?bust=real-${runId}`);
    const result = mod.getPluginData();

    assert.equal(result, REAL_LIKE_PLUGIN_DATA);
    assert.equal(
      readMarker(),
      REAL_LIKE_PLUGIN_DATA,
      "marker now points at the real path",
    );
  });

  it("hooks/lib/common.mjs resolvePluginData applies the same guard", async () => {
    const sentinel = "/Users/test/sentinel-hooks";
    writeFileSync(MARKER, sentinel, "utf-8");

    process.env.CLAUDE_PLUGIN_DATA = TEMP_PLUGIN_DATA;
    const mod = await import(`../plugin/hooks/lib/common.mjs?bust=hooks-${runId}`);
    const result = mod.resolvePluginData();

    assert.equal(result, TEMP_PLUGIN_DATA);
    assert.equal(readMarker(), sentinel, "hooks variant preserves marker too");
  });
});
