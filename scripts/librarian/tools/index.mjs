// scripts/librarian/tools/index.mjs : tool dispatcher and TOOL_DEFS for the librarian.
//
// Exports:
//   TOOL_DEFS — 11 tool definitions for Ollama function calling
//   executeTool(name, args, ctx) — dispatches to the correct handler
//   submitVoiceFlag, submitTagSuggestion, submitDuplicateFlag — re-exported for shim compat
//   extractModelProb — re-exported for shim compat
//
// The special-case for submit_link (cosine_score + model_prob injection from ctx)
// is preserved verbatim from the original librarian-tools.mjs lines 506-518.

import {
  findSimilar,
  searchVault,
  findClusters,
  getInlinks,
  getOutlinks,
  getTags,
  readNote,
  submitLink,
  submitSuspect,
  cap,
  isUnitProb,
} from './shared.mjs';
import { extractModelProb } from './model-prob.mjs';
import { submitVoiceFlag } from './voice.mjs';
import { submitTagSuggestion } from './tag-suggest.mjs';
import { submitDuplicateFlag } from './duplicate.mjs';

export { extractModelProb, submitVoiceFlag, submitTagSuggestion, submitDuplicateFlag };

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'find_similar',
      description: 'Find semantically similar notes by embedding distance',
      parameters: {
        type: 'object',
        properties: {
          note_path: {
            type: 'string',
            description: 'Path to the note, e.g. 3-permanent/foo.md',
          },
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
          note_path: {
            type: 'string',
            description: 'Path to the note, e.g. 3-permanent/foo.md',
          },
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
          note_path: {
            type: 'string',
            description: 'Path to the note, e.g. 3-permanent/foo.md',
          },
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
          note_path: {
            type: 'string',
            description: 'Path to the note, e.g. 3-permanent/foo.md',
          },
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
          target: {
            type: 'string',
            description: 'Path of the orphan note that needs a link',
          },
          suggested_link: {
            type: 'string',
            description: 'Path of the note to link to',
          },
          confidence: {
            type: 'string',
            description: 'Confidence level: "high" or "review"',
          },
          reason: {
            type: 'string',
            description: 'Reason for the link suggestion',
          },
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
          current_title: {
            type: 'string',
            description: 'The current title of the note',
          },
          reason: {
            type: 'string',
            description: 'Why the title is topic-not-insight',
          },
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
          reason: {
            type: 'string',
            description: 'Reason for flagging this note',
          },
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

/**
 * Execute a tool by name, injecting cosine_score and model_prob from ctx for submit_link.
 * Preserves the exact injection logic from original librarian-tools.mjs lines 506-518.
 *
 * @param {string} name
 * @param {object} args
 * @param {{ neighbourScores?: Map<string,number>, modelProb?: number | null }} [ctx]
 * @returns {Promise<string>}
 */
export async function executeTool(name, args, ctx) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error('Unknown tool: ' + name);
  let result;
  if (name === 'find_similar') {
    result = await handler(args, ctx);
  } else if (name === 'submit_link') {
    const inject = {};
    if (ctx && ctx.neighbourScores && typeof args?.suggested_link === 'string') {
      const cs = ctx.neighbourScores.get(args.suggested_link);
      if (typeof cs === 'number') inject.cosine_score = cs;
    }
    if (ctx && isUnitProb(ctx.modelProb)) inject.model_prob = ctx.modelProb;
    result = await handler({ ...args, ...inject });
  } else {
    result = await handler(args);
  }
  return typeof result === 'string' ? result : cap(JSON.stringify(result));
}
