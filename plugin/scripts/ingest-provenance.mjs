import { join } from 'node:path';
import { appendJsonlLine } from './lib/jsonl.mjs';

export function appendIngestEvent(pluginData, event) {
  const record = {
    ts: new Date().toISOString(),
    skill: 'ingest',
    source: 'repo',
    ...event,
  };
  appendJsonlLine(join(pluginData, 'ingest-provenance.jsonl'), record);
}
