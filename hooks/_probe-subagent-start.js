#!/usr/bin/env node
// Temporary probe to verify SubagentStart hook event fires at runtime.
// Creates a marker file when any subagent spawns.
// Remove after confirming the event fires (planned for v1.15.0 where this
// gets replaced by the real subagent-start-provenance.js hook).
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const marker = join(tmpdir(), 'subagent-start-fire-test.marker');
const ts = new Date().toISOString();

let agentInfo = '';
try {
  let data = '';
  process.stdin.setEncoding('utf8');
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1000);
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timeout); resolve(); });
  });
  if (data.trim()) {
    const parsed = JSON.parse(data);
    agentInfo = ` agent_type=${parsed.agent_type || '?'} agent_id=${parsed.agent_id || '?'}`;
  }
} catch {}

appendFileSync(marker, `${ts}${agentInfo}\n`);
