import test from "node:test";
import assert from "node:assert/strict";
import { DATA_FILES } from "../scripts/lib/paths.mjs";

test("harvest denylist + dedup log anchor under plugin-data", () => {
  const pd = "/tmp/pd";
  assert.equal(DATA_FILES.harvestDenylist(pd), "/tmp/pd/.harvest-denylist");
  assert.equal(DATA_FILES.harvestedLog(pd), "/tmp/pd/.harvested-log");
});
