#!/usr/bin/env node

import { join, basename } from 'path';
import { readFileSync } from 'fs';
import { PLUGIN_DATA, VAULT_PATH } from './lib/constants.mjs';
import {
  openEdgeDb, addEdge, removeEdge, removeEdgesByNote,
  getEdgesFrom, getEdgesTo, getDownstream,
  getSoleJustificationDependents, getPendingReview,
  confirmEdge, rejectEdge, saveDb,
  addSupersession, removeSupersession, listSupersessions, findMatchingSupersessions,
} from './lib/edges.mjs';

const DB_FILE = join(PLUGIN_DATA, 'edges.db');
const args = process.argv.slice(2);
const cmd = args[0];

function parseFlag(flag, defaultVal) {
  const idx = args.indexOf(flag);
  if (idx < 0) return defaultVal;
  return args[idx + 1] !== undefined ? args[idx + 1] : defaultVal;
}

function out(data) {
  console.log(JSON.stringify(data, null, 2));
}

function extractEdgeContext(fromPath, toTarget) {
  try {
    const fullPath = join(VAULT_PATH, fromPath);
    const content = readFileSync(fullPath, 'utf-8');
    const fmEnd = content.match(/^---\n[\s\S]*?\n---\n?/);
    const body = fmEnd ? content.slice(fmEnd[0].length) : content;
    const linkRe = new RegExp(`\\[\\[${toTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\|[^\\]]+)?\\]\\]`);
    const m = linkRe.exec(body);
    if (!m) return null;
    const start = Math.max(0, m.index - 100);
    const end = Math.min(body.length, m.index + m[0].length + 100);
    return body.slice(start, end).replace(/\n/g, ' ').trim();
  } catch {
    return null;
  }
}

function usage() {
  out({
    error: 'Unknown command',
    commands: [
      'add <from> <to> <type> [--confidence high|medium|low] [--source-graph local] [--direction-flipped 0|1]',
      'remove <id>',
      'list <note-path>',
      'downstream <note-path> [--max-depth 10]',
      'sole-dependents <note-path>',
      'review (shows context from source notes)',
      'review-count',
      'super-add <pattern> [--replacement <note-path>] [--reason <text>] [--date YYYY-MM-DD]',
      'super-list',
      'super-check <query>',
      'super-remove <id>',
      'confirm <id> [--type new-type]',
      'reject <id>',
      'stats',
    ],
  });
  process.exit(1);
}

async function main() {
  if (!cmd) usage();

  const db = await openEdgeDb(DB_FILE);

  try {
    switch (cmd) {
      case 'add': {
        const fromPath = args[1];
        const toPath = args[2];
        const edgeType = args[3];
        if (!fromPath || !toPath || !edgeType) {
          out({ error: 'Usage: add <from-path> <to-path> <edge-type>' });
          process.exit(1);
        }
        const confidence = parseFlag('--confidence', 'high');
        const sourceGraph = parseFlag('--source-graph', 'local');
        const directionFlipped = parseFlag('--direction-flipped', '0') === '1' ? 1 : 0;
        const id = addEdge(db, { fromPath, toPath, edgeType, confidence, sourceGraph, directionFlipped });
        saveDb(db, DB_FILE);
        out({ ok: true, id });
        break;
      }

      case 'remove': {
        const id = parseInt(args[1], 10);
        if (isNaN(id)) {
          out({ error: 'Usage: remove <id>' });
          process.exit(1);
        }
        removeEdge(db, id);
        saveDb(db, DB_FILE);
        out({ ok: true, removed: id });
        break;
      }

      case 'list': {
        const notePath = args[1];
        if (!notePath) {
          out({ error: 'Usage: list <note-path>' });
          process.exit(1);
        }
        const from = getEdgesFrom(db, notePath);
        const to = getEdgesTo(db, notePath);
        out({ note: notePath, outgoing: from, incoming: to });
        break;
      }

      case 'downstream': {
        const notePath = args[1];
        if (!notePath) {
          out({ error: 'Usage: downstream <note-path>' });
          process.exit(1);
        }
        const maxDepth = parseInt(parseFlag('--max-depth', '10'), 10);
        const tree = getDownstream(db, notePath, maxDepth);
        out({ root: notePath, downstream: tree });
        break;
      }

      case 'sole-dependents': {
        const notePath = args[1];
        if (!notePath) {
          out({ error: 'Usage: sole-dependents <note-path>' });
          process.exit(1);
        }
        const dependents = getSoleJustificationDependents(db, notePath);
        out({ root: notePath, sole_dependents: dependents });
        break;
      }

      case 'review': {
        const pending = getPendingReview(db);
        const enriched = pending.map(edge => {
          const ctx = extractEdgeContext(edge.from_path, edge.to_path);
          return ctx ? { ...edge, context: ctx } : edge;
        });
        out({ pending_count: pending.length, edges: enriched });
        break;
      }

      case 'review-count': {
        const countResult = db.exec("SELECT COUNT(*) FROM edges WHERE confidence = 'medium'");
        const count = countResult.length ? countResult[0].values[0][0] : 0;
        out({ pending_count: count });
        break;
      }

      case 'confirm': {
        const id = parseInt(args[1], 10);
        if (isNaN(id)) {
          out({ error: 'Usage: confirm <id> [--type new-type]' });
          process.exit(1);
        }
        const newType = parseFlag('--type', null);
        confirmEdge(db, id, newType);
        saveDb(db, DB_FILE);
        out({ ok: true, confirmed: id });
        break;
      }

      case 'reject': {
        const id = parseInt(args[1], 10);
        if (isNaN(id)) {
          out({ error: 'Usage: reject <id>' });
          process.exit(1);
        }
        rejectEdge(db, id);
        saveDb(db, DB_FILE);
        out({ ok: true, rejected: id });
        break;
      }

      case 'super-add': {
        const pattern = args[1];
        if (!pattern) {
          out({ error: 'Usage: super-add <pattern> [--replacement <note-path>] [--reason <text>] [--date YYYY-MM-DD]' });
          process.exit(1);
        }
        const replacementNotePath = parseFlag('--replacement', null);
        const reason = parseFlag('--reason', null);
        const supersededDate = parseFlag('--date', null);
        const id = addSupersession(db, { oldPatternQuery: pattern, replacementNotePath, reason, supersededDate });
        saveDb(db, DB_FILE);
        out({ ok: true, id });
        break;
      }

      case 'super-list': {
        const items = listSupersessions(db);
        out({ count: items.length, supersessions: items });
        break;
      }

      case 'super-check': {
        const query = args.slice(1).join(' ');
        if (!query) {
          out({ error: 'Usage: super-check <query>' });
          process.exit(1);
        }
        const matches = findMatchingSupersessions(db, query);
        out({ query, matches });
        break;
      }

      case 'super-remove': {
        const id = parseInt(args[1], 10);
        if (isNaN(id)) {
          out({ error: 'Usage: super-remove <id>' });
          process.exit(1);
        }
        removeSupersession(db, id);
        saveDb(db, DB_FILE);
        out({ ok: true, removed: id });
        break;
      }

      case 'stats': {
        const allRows = db.exec('SELECT COUNT(*) as total FROM edges');
        const total = allRows.length ? allRows[0].values[0][0] : 0;

        const byType = db.exec('SELECT edge_type, COUNT(*) as count FROM edges GROUP BY edge_type ORDER BY count DESC');
        const types = {};
        if (byType.length) byType[0].values.forEach(([t, c]) => { types[t] = c; });

        const byConf = db.exec('SELECT confidence, COUNT(*) as count FROM edges GROUP BY confidence ORDER BY count DESC');
        const confidence = {};
        if (byConf.length) byConf[0].values.forEach(([c, n]) => { confidence[c] = n; });

        const bySource = db.exec('SELECT source_graph, COUNT(*) as count FROM edges GROUP BY source_graph ORDER BY count DESC');
        const sources = {};
        if (bySource.length) bySource[0].values.forEach(([s, n]) => { sources[s] = n; });

        out({ total, by_type: types, by_confidence: confidence, by_source: sources });
        break;
      }

      default:
        usage();
    }
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
