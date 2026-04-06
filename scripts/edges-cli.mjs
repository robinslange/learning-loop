#!/usr/bin/env node

import { join } from 'path';
import { PLUGIN_DATA } from './lib/constants.mjs';
import {
  openEdgeDb, addEdge, removeEdge, removeEdgesByNote,
  getEdgesFrom, getEdgesTo, getDownstream,
  getSoleJustificationDependents, getPendingReview,
  confirmEdge, rejectEdge, saveDb,
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

function usage() {
  out({
    error: 'Unknown command',
    commands: [
      'add <from> <to> <type> [--confidence high|medium|low] [--source-graph local]',
      'remove <id>',
      'list <note-path>',
      'downstream <note-path> [--max-depth 10]',
      'sole-dependents <note-path>',
      'review',
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
        const id = addEdge(db, { fromPath, toPath, edgeType, confidence, sourceGraph });
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
        out({ pending_count: pending.length, edges: pending });
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
