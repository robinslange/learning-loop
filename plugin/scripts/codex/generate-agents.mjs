#!/usr/bin/env node
// scripts/codex/generate-agents.mjs : plugin/agents/*.md -> Codex agent TOML.
//
// Claude Code discovers subagents from markdown files bundled in the plugin.
// Codex discovers them from standalone TOML files in ~/.codex/agents/ and has
// no plugin manifest field for agents, so they cannot ship inside the package —
// install.sh generates them instead. The markdown files stay the single source
// of truth; this script is a projection, never an edit target.
//
// Usage: node generate-agents.mjs [--out <dir>] [--list]

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../lib/markdown-parse.mjs';

const AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../agents');

// Codex agent names are flat — there is no plugin namespace — so the prefix is
// what keeps these from colliding with a built-in or a hand-written agent.
const PREFIX = 'learning-loop-';

// Claude Code model aliases mapped onto the Codex tiers documented for
// subagents. Verify these slugs against the Codex release you are running:
// model names move faster than this file does, and a stale slug makes the agent
// fall back to the parent's model rather than failing loudly.
const MODELS = {
  opus: 'gpt-5.6',
  sonnet: 'gpt-5.6',
  haiku: 'gpt-5.6-luna',
};

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

// Codex custom agents cannot restrict the tool list, so the `tools:` line only
// tells us whether the agent ever writes. One that does not gets sandboxed.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tomlMultiline(value) {
  const escaped = String(value).replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  return `"""\n${escaped.endsWith('\n') ? escaped : escaped + '\n'}"""`;
}

/**
 * Projects one agent markdown file onto a Codex custom-agent TOML file.
 * @param {string} source Full markdown text.
 * @param {string} fallbackName Used when the file omits `name:`.
 * @returns {{name: string, toml: string}}
 */
export function toCodexAgent(source, fallbackName) {
  const { fm, body } = parseFrontmatter(source);
  const name = PREFIX + (fm.name || fallbackName);
  const tools = String(fm.tools || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const lines = [`name = ${tomlString(name)}`, `description = ${tomlString(fm.description || '')}`];

  const model = MODELS[fm.model];
  if (model) lines.push(`model = ${tomlString(model)}`);
  if (EFFORTS.has(fm.effort)) lines.push(`model_reasoning_effort = ${tomlString(fm.effort)}`);
  if (tools.length && !tools.some((t) => WRITE_TOOLS.has(t))) {
    lines.push('sandbox_mode = "read-only"');
  }

  lines.push(`developer_instructions = ${tomlMultiline(body.trim())}`);
  return { name, toml: lines.join('\n') + '\n' };
}

function main(argv) {
  const outFlag = argv.indexOf('--out');
  const outDir = outFlag === -1 ? join(homedir(), '.codex', 'agents') : argv[outFlag + 1];
  const listOnly = argv.includes('--list');

  const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));
  if (!listOnly) mkdirSync(outDir, { recursive: true });

  const written = [];
  for (const file of files) {
    const { name, toml } = toCodexAgent(
      readFileSync(join(AGENTS_DIR, file), 'utf-8'),
      file.replace(/\.md$/, ''),
    );
    const target = join(outDir, `${name}.toml`);
    if (!listOnly) writeFileSync(target, toml);
    written.push(target);
  }

  process.stdout.write(`${written.length} agents ${listOnly ? 'found' : 'written'} -> ${outDir}\n`);
  return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
