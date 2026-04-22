import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const runId = randomBytes(4).toString("hex");
const TEMP_ROOT = join(tmpdir(), `ll-voice-gate-${runId}`);
const TEMP_VAULT = join(TEMP_ROOT, "vault");
const TEMP_DATA = join(TEMP_ROOT, "plugin-data");
const LIBRARIAN_DIR = join(TEMP_DATA, "librarian");

function queuePath() {
  return join(LIBRARIAN_DIR, "queue.jsonl");
}

function readQueue() {
  const p = queuePath();
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function statePath() {
  return join(LIBRARIAN_DIR, "state.json");
}

function resetState() {
  writeFileSync(
    statePath(),
    JSON.stringify({
      visited: [],
      notes_visited: 0,
      link_suggestions: 0,
      voice_flags: 0,
      staleness_suspects: 0,
      counters: {},
    }) + "\n",
  );
  if (existsSync(queuePath())) rmSync(queuePath());
}

describe("voice-gate structured-output classification", () => {
  let originalFetch;

  before(() => {
    mkdirSync(join(TEMP_VAULT, "0-inbox"), { recursive: true });
    mkdirSync(LIBRARIAN_DIR, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;
    originalFetch = globalThis.fetch;

    writeFileSync(
      join(TEMP_VAULT, "0-inbox", "some-topic-title.md"),
      "---\nstatus: inbox\n---\nSome content.\n",
    );
    writeFileSync(
      join(
        TEMP_VAULT,
        "0-inbox",
        "cached-array-references-mutate-through-reverse.md",
      ),
      "---\nstatus: inbox\n---\nClaim content.\n",
    );
  });

  after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.CLAUDE_PLUGIN_DATA;
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  });

  it('queues voice_flag when model returns "topic"', async () => {
    resetState();

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        message: { content: JSON.stringify({ label: "topic" }) },
      }),
    }));

    const mod = await import(`../scripts/librarian.mjs?bust=topic-${runId}`);
    await mod.__test__.voiceCheck("0-inbox/some-topic-title.md");

    const items = readQueue();
    assert.equal(items.length, 1, "expected 1 queue item");
    assert.equal(items[0].task, "voice_flag");
    assert.equal(items[0].target, "0-inbox/some-topic-title.md");
    assert.equal(items[0].current_title, "some-topic-title");
    assert.match(items[0].reason, /structured-output classifier/);

    const state = JSON.parse(readFileSync(statePath(), "utf-8"));
    assert.equal(state.voice_flags, 1);
  });

  it('does not queue when model returns "claim"', async () => {
    resetState();

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({ label: "claim" }),
        },
      }),
    }));

    const mod = await import(`../scripts/librarian.mjs?bust=claim-${runId}`);
    await mod.__test__.voiceCheck(
      "0-inbox/cached-array-references-mutate-through-reverse.md",
    );

    const items = readQueue();
    assert.equal(items.length, 0, "expected no queue items for claim");
  });

  it("does not crash on malformed response", async () => {
    resetState();

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        message: { content: "not valid json at all" },
      }),
    }));

    const mod = await import(
      `../scripts/librarian.mjs?bust=malformed-${runId}`
    );
    await mod.__test__.voiceCheck("0-inbox/some-topic-title.md");

    const items = readQueue();
    assert.equal(
      items.length,
      0,
      "expected no queue items on malformed response",
    );
  });

  it("skips gracefully on HTTP error from ollama", async () => {
    resetState();

    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      status: 500,
    }));

    const mod = await import(
      `../scripts/librarian.mjs?bust=http-error-${runId}`
    );
    await mod.__test__.voiceCheck("0-inbox/some-topic-title.md");

    const items = readQueue();
    assert.equal(items.length, 0, "expected no queue items on HTTP error");
  });
});
