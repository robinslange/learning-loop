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
const TEMP_ROOT = join(tmpdir(), `ll-dup-classifier-${runId}`);
const TEMP_VAULT = join(TEMP_ROOT, "vault");
const TEMP_DATA = join(TEMP_ROOT, "plugin-data");
const LIBRARIAN_DIR = join(TEMP_DATA, "librarian");

const TARGET = "3-permanent/target.md";
const NEIGHBOUR_A = "3-permanent/neighbour-a.md";
const NEIGHBOUR_B = "3-permanent/neighbour-b.md";

const NEIGHBOURS = [
  { path: NEIGHBOUR_A, score: 0.93 },
  { path: NEIGHBOUR_B, score: 0.81 },
];

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
      duplicate_flags: 0,
      staleness_suspects: 0,
      counters: {},
    }) + "\n",
  );
  if (existsSync(queuePath())) rmSync(queuePath());
}

describe("duplicate classifier structured-output flag", () => {
  let originalFetch;

  before(() => {
    mkdirSync(join(TEMP_VAULT, "3-permanent"), { recursive: true });
    mkdirSync(LIBRARIAN_DIR, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;
    process.env.VAULT_PATH = TEMP_VAULT;
    originalFetch = globalThis.fetch;

    writeFileSync(
      join(TEMP_VAULT, TARGET),
      "---\nstatus: inbox\n---\nClaim about widgets.\n",
    );
    writeFileSync(
      join(TEMP_VAULT, NEIGHBOUR_A),
      "---\nstatus: permanent\n---\nThe same claim about widgets.\n",
    );
    writeFileSync(
      join(TEMP_VAULT, NEIGHBOUR_B),
      "---\nstatus: permanent\n---\nA different claim about gadgets.\n",
    );
  });

  after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.VAULT_PATH;
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  });

  it('queues duplicate_flag when model returns "duplicate" with valid neighbour', async () => {
    resetState();

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({
            relationship: "duplicate",
            duplicate_of: NEIGHBOUR_A,
          }),
        },
      }),
    }));

    const mod = await import(
      `../scripts/librarian.mjs?bust=dup-happy-${runId}`
    );
    await mod.__test__.duplicateCheck(TARGET, {
      neighboursOverride: NEIGHBOURS,
    });

    const items = readQueue();
    assert.equal(items.length, 1);
    assert.equal(items[0].task, "duplicate_flag");
    assert.equal(items[0].target, TARGET);
    assert.equal(items[0].duplicate_of, NEIGHBOUR_A);
    assert.equal(items[0].similarity, 0.93);

    const state = JSON.parse(readFileSync(statePath(), "utf-8"));
    assert.equal(state.duplicate_flags, 1);
  });

  it('does not queue when model returns "same_topic"', async () => {
    resetState();

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({
            relationship: "same_topic",
            duplicate_of: null,
          }),
        },
      }),
    }));

    const mod = await import(`../scripts/librarian.mjs?bust=dup-same-${runId}`);
    await mod.__test__.duplicateCheck(TARGET, {
      neighboursOverride: NEIGHBOURS,
    });

    assert.equal(readQueue().length, 0);
  });

  it('does not queue when model returns "unrelated"', async () => {
    resetState();

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({
            relationship: "unrelated",
            duplicate_of: null,
          }),
        },
      }),
    }));

    const mod = await import(
      `../scripts/librarian.mjs?bust=dup-unrel-${runId}`
    );
    await mod.__test__.duplicateCheck(TARGET, {
      neighboursOverride: NEIGHBOURS,
    });

    assert.equal(readQueue().length, 0);
  });

  it("skips when model names a non-neighbour as duplicate", async () => {
    resetState();

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({
            relationship: "duplicate",
            duplicate_of: "3-permanent/some-other-note.md",
          }),
        },
      }),
    }));

    const mod = await import(
      `../scripts/librarian.mjs?bust=dup-nonbr-${runId}`
    );
    await mod.__test__.duplicateCheck(TARGET, {
      neighboursOverride: NEIGHBOURS,
    });

    assert.equal(readQueue().length, 0);
  });

  it("accepts a neighbour identified by basename slug", async () => {
    resetState();

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({
            relationship: "duplicate",
            duplicate_of: "neighbour-a",
          }),
        },
      }),
    }));

    const mod = await import(`../scripts/librarian.mjs?bust=dup-slug-${runId}`);
    await mod.__test__.duplicateCheck(TARGET, {
      neighboursOverride: NEIGHBOURS,
    });

    const items = readQueue();
    assert.equal(items.length, 1);
    assert.equal(items[0].duplicate_of, NEIGHBOUR_A);
  });

  it("does not crash on malformed response", async () => {
    resetState();

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ message: { content: "unrelated" } }),
    }));

    const mod = await import(
      `../scripts/librarian.mjs?bust=dup-malformed-${runId}`
    );
    await mod.__test__.duplicateCheck(TARGET, {
      neighboursOverride: NEIGHBOURS,
    });

    assert.equal(readQueue().length, 0);
  });

  it("skips gracefully on HTTP error from ollama", async () => {
    resetState();

    globalThis.fetch = mock.fn(async () => ({ ok: false, status: 500 }));

    const mod = await import(`../scripts/librarian.mjs?bust=dup-http-${runId}`);
    await mod.__test__.duplicateCheck(TARGET, {
      neighboursOverride: NEIGHBOURS,
    });

    assert.equal(readQueue().length, 0);
  });

  it("returns without queueing when there are no neighbours", async () => {
    resetState();

    let fetchCalled = false;
    globalThis.fetch = mock.fn(async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ message: { content: "{}" } }) };
    });

    const mod = await import(
      `../scripts/librarian.mjs?bust=dup-noneigh-${runId}`
    );
    await mod.__test__.duplicateCheck(TARGET, { neighboursOverride: [] });

    assert.equal(fetchCalled, false);
    assert.equal(readQueue().length, 0);
  });
});
