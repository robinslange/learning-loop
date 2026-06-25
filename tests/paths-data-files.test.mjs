import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DATA_FILES } from '../plugin/scripts/lib/paths.mjs';

test('harvest denylist + dedup log anchor under plugin-data', () => {
  const pd = join('/tmp', 'pd');
  assert.equal(DATA_FILES.harvestDenylist(pd), join(pd, '.harvest-denylist'));
  assert.equal(DATA_FILES.harvestedLog(pd), join(pd, '.harvested-log'));
});
