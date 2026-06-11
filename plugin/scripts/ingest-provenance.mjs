import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function appendIngestEvent(pluginData, event) {
  mkdirSync(pluginData, { recursive: true });
  const record = {
    ts: new Date().toISOString(),
    skill: 'ingest',
    source: 'repo',
    ...event,
  };
  appendFileSync(join(pluginData, 'ingest-provenance.jsonl'), JSON.stringify(record) + '\n');
}
