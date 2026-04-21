import { run } from './binary.mjs';
import { openReadonly } from './sqljs.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { appendItem, newItemId } from './librarian-queue.mjs';
import { VAULT_PATH, DB_PATH } from './constants.mjs';

const MAX_RESULT = 1500;

function cap(str) {
  if (typeof str !== 'string') str = JSON.stringify(str);
  return str.length > MAX_RESULT ? str.slice(0, MAX_RESULT) + '…' : str;
}

function slug(notePath) {
  const name = notePath.split('/').pop();
  return name.replace(/\.md$/, '');
}

let _db = null;

async function getDb() {
  if (_db) return _db;
  _db = await openReadonly(DB_PATH);
  return _db;
}

async function findSimilar({ note_path }) {
  const results = run(['similar', DB_PATH, note_path, '--top', '5']);
  return cap(JSON.stringify(results));
}

async function searchVault({ query }) {
  const results = run(['query', DB_PATH, query, '--top', '5']);
  return cap(JSON.stringify(results));
}

async function findClusters() {
  const results = run(['cluster', DB_PATH, '--threshold', '0.85']);
  return cap(JSON.stringify(results));
}

async function getInlinks({ note_path }) {
  const db = await getDb();
  const s = slug(note_path);
  const rows = db.exec(
    `SELECT COUNT(*) as count FROM links WHERE target_path = ? AND target_path NOT LIKE '%[%'`,
    [s]
  );
  if (!rows.length) return '0';
  const count = rows[0].values[0][0];
  return String(count);
}

async function getOutlinks({ note_path }) {
  const db = await getDb();
  const rows = db.exec(
    `SELECT target_path FROM links WHERE source_path = ? AND target_path NOT LIKE '%[%'`,
    [note_path]
  );
  if (!rows.length) return cap(JSON.stringify([]));
  const targets = rows[0].values.map(r => r[0]);
  return cap(JSON.stringify(targets));
}

async function getTags() {
  const results = run(['tags', DB_PATH]);
  return cap(JSON.stringify(results));
}

async function readNote({ note_path }) {
  const fullPath = join(VAULT_PATH, note_path);
  if (!existsSync(fullPath)) return `Note not found: ${note_path}`;
  let content = readFileSync(fullPath, 'utf-8');
  // Strip YAML frontmatter
  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    if (end !== -1) {
      content = content.slice(end + 4).trimStart();
    }
  }
  return cap(content.slice(0, 500));
}

async function submitLink({ target, suggested_link, confidence, reason }) {
  const item = {
    id: newItemId(),
    task: 'link_suggestion',
    target,
    suggested_link,
    confidence,
    reason,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  appendItem(item);
  return `Queued link suggestion: ${item.id}`;
}

async function submitVoiceFlag({ target, current_title, reason }) {
  const item = {
    id: newItemId(),
    task: 'voice_flag',
    target,
    current_title,
    reason,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  appendItem(item);
  return `Queued voice flag: ${item.id}`;
}

async function submitSuspect({ target, reason }) {
  const item = {
    id: newItemId(),
    task: 'staleness_suspect',
    target,
    reason,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  appendItem(item);
  return `Queued suspect: ${item.id}`;
}

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'find_similar',
      description: 'Find semantically similar notes by embedding distance',
      parameters: {
        type: 'object',
        properties: {
          note_path: { type: 'string', description: 'Path to the note, e.g. 3-permanent/foo.md' },
        },
        required: ['note_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_vault',
      description: 'Semantic text search across all vault notes',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query text' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_clusters',
      description: 'Find near-duplicate note pairs above similarity threshold',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_inlinks',
      description: 'Count inbound links to a note',
      parameters: {
        type: 'object',
        properties: {
          note_path: { type: 'string', description: 'Path to the note, e.g. 3-permanent/foo.md' },
        },
        required: ['note_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_outlinks',
      description: 'List outbound link targets from a note',
      parameters: {
        type: 'object',
        properties: {
          note_path: { type: 'string', description: 'Path to the note, e.g. 3-permanent/foo.md' },
        },
        required: ['note_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tags',
      description: 'List all tags with their note counts',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_note',
      description: 'Read note body (frontmatter stripped, capped at 500 chars)',
      parameters: {
        type: 'object',
        properties: {
          note_path: { type: 'string', description: 'Path to the note, e.g. 3-permanent/foo.md' },
        },
        required: ['note_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_link',
      description: 'Submit a link suggestion between two notes',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Path of the orphan note that needs a link' },
          suggested_link: { type: 'string', description: 'Path of the note to link to' },
          confidence: { type: 'string', description: 'Confidence level: "high" or "review"' },
          reason: { type: 'string', description: 'Reason for the link suggestion' },
        },
        required: ['target', 'suggested_link', 'confidence', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_voice_flag',
      description: 'Flag a note title as topic-not-insight (voice issue)',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Path of the note to flag' },
          current_title: { type: 'string', description: 'The current title of the note' },
          reason: { type: 'string', description: 'Why the title is topic-not-insight' },
        },
        required: ['target', 'current_title', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_suspect',
      description: 'Flag a note for Claude investigation (staleness, accuracy concern, etc.)',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Path of the note to flag' },
          reason: { type: 'string', description: 'Reason for flagging this note' },
        },
        required: ['target', 'reason'],
      },
    },
  },
];

const HANDLERS = {
  find_similar: findSimilar,
  search_vault: searchVault,
  find_clusters: findClusters,
  get_inlinks: getInlinks,
  get_outlinks: getOutlinks,
  get_tags: getTags,
  read_note: readNote,
  submit_link: submitLink,
  submit_voice_flag: submitVoiceFlag,
  submit_suspect: submitSuspect,
};

export async function executeTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  const result = await handler(args);
  return typeof result === 'string' ? result : cap(JSON.stringify(result));
}
