import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Counts and rosters stated in prose drift the moment a handler, agent, or
// shared skill is added — the roster tables in README/ARCHITECTURE/guide have
// each been wrong by one at some point. Derive the truth from disk and assert
// the docs agree, so the next addition fails here instead of shipping a lie.

const ROOT = join(import.meta.dirname, '..');
const PLUGIN = join(ROOT, 'plugin');

const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');
const mdNames = (dir) =>
  readdirSync(join(PLUGIN, dir))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));

const hooksJson = JSON.parse(read('plugin', 'hooks', 'hooks.json'));

const EVENT_TYPES = Object.keys(hooksJson.hooks);
const HANDLERS = [
  ...new Set(
    JSON.stringify(hooksJson).match(/hooks\/[a-z-]+\.js/g) ?? [],
  ),
];
const AGENTS = mdNames('agents');
const SHARED = mdNames('agents-shared');
const SKILLS = readdirSync(join(PLUGIN, 'skills'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => {
    try {
      readFileSync(join(PLUGIN, 'skills', name, 'SKILL.md'));
      return true;
    } catch {
      return false;
    }
  });

const WORDS = {
  1: 'one',
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
  7: 'seven',
  8: 'eight',
  9: 'nine',
  10: 'ten',
  11: 'eleven',
  12: 'twelve',
};

// getConfig() falls back to `<pluginRoot>/config.json` when PLUGIN_DATA has no
// config yet and MIGRATES it into PLUGIN_DATA — so anything in the shipped file
// becomes a new user's real config on first run. It shipped
// `vault_path: "~/brain/brain"`, the maintainer's own path, which every new
// install inherited and `/init` then offered back as "I found your vault at…".
test('the shipped config carries no machine-specific paths', () => {
  const shipped = JSON.parse(read('plugin', 'config.json'));

  assert.ok(
    !('vault_path' in shipped),
    'the shipped config must not preset vault_path — /init detects it per machine',
  );

  const serialized = JSON.stringify(shipped);
  for (const pattern of [/\/Users\//, /\/home\//, /\/root\//, /C:\\\\/]) {
    assert.ok(!pattern.test(serialized), `shipped config contains an absolute path: ${pattern}`);
  }
  assert.ok(!/brain\/brain/.test(serialized), 'shipped config contains a personal vault path');
});

test('every hook handler in hooks.json exists on disk', () => {
  for (const rel of HANDLERS) {
    assert.doesNotThrow(
      () => readFileSync(join(PLUGIN, rel)),
      `hooks.json references ${rel}, which does not exist`,
    );
  }
});

test('prose hook counts match hooks.json', () => {
  const h = WORDS[HANDLERS.length];
  const e = WORDS[EVENT_TYPES.length];
  assert.ok(h && e, `no word form for ${HANDLERS.length}/${EVENT_TYPES.length}`);

  const claims = [
    ['README.md', read('README.md')],
    ['ARCHITECTURE.md', read('ARCHITECTURE.md')],
    ['guide/configuration.md', read('guide', 'configuration.md')],
  ];

  for (const [name, text] of claims) {
    // Any "<word> ... hook handlers ... <word> ... event types" sentence must
    // use the real numbers. Matching the shape rather than exact prose keeps
    // the assertion from breaking on a rewording.
    const sentences = text.match(/\b\w+ (?:lifecycle )?hook handlers across \w+ (?:Claude Code )?event types/g) ?? [];
    assert.ok(
      sentences.length > 0,
      `${name} no longer states a hook-handler count — update this test if that is deliberate`,
    );
    for (const s of sentences) {
      assert.ok(
        s.startsWith(`${h} `) || s.startsWith(`${h.charAt(0).toUpperCase() + h.slice(1)} `),
        `${name}: "${s}" — there are ${HANDLERS.length} handlers (${h})`,
      );
      assert.ok(
        s.includes(`across ${e} `),
        `${name}: "${s}" — there are ${EVENT_TYPES.length} event types (${e})`,
      );
    }
  }
});

test('every hook handler appears in the guide/configuration.md roster', () => {
  const roster = read('guide', 'configuration.md');
  for (const rel of HANDLERS) {
    const base = rel.replace('hooks/', '');
    assert.ok(
      roster.includes(base),
      `guide/configuration.md calls its table the canonical roster but omits ${base}`,
    );
  }
});

test('every PostToolUse matcher in the docs matches hooks.json', () => {
  const matchers = hooksJson.hooks.PostToolUse.map((h) => h.matcher);
  // The guide escapes pipes and underscores for markdown; compare unescaped.
  const guide = read('guide', 'configuration.md').replace(/\\/g, '');
  for (const m of matchers) {
    assert.ok(
      guide.includes(m),
      `guide/configuration.md does not document the PostToolUse matcher "${m}"`,
    );
  }
});

test('agent and shared-skill counts in the docs match disk', () => {
  const readme = read('README.md');
  const agents = read('guide', 'agents.md');

  assert.ok(
    readme.includes(`${AGENTS.length} specialized agents and ${SHARED.length} shared skills`),
    `README.md must say "${AGENTS.length} specialized agents and ${SHARED.length} shared skills"`,
  );
  assert.ok(
    agents.includes(`share ${SHARED.length} shared skills`),
    `guide/agents.md must say "share ${SHARED.length} shared skills"`,
  );
  assert.ok(
    agents.includes(`Agents share ${SHARED.length} skills`),
    `guide/agents.md must say "Agents share ${SHARED.length} skills"`,
  );
});

test('every agent on disk is documented in guide/agents.md', () => {
  const agents = read('guide', 'agents.md');
  for (const name of AGENTS) {
    assert.ok(agents.includes(name), `guide/agents.md omits the ${name} agent`);
  }
});

test('every shared skill on disk is documented in guide/agents.md', () => {
  const agents = read('guide', 'agents.md');
  for (const name of SHARED) {
    assert.ok(agents.includes(`**${name}**`), `guide/agents.md omits the ${name} shared skill`);
  }
});

test('every agent filename matches its frontmatter name', () => {
  for (const name of AGENTS) {
    const fm = readFileSync(join(PLUGIN, 'agents', `${name}.md`), 'utf8');
    const m = fm.match(/^---\n(?:.*\n)*?name:\s*(\S+)/);
    assert.ok(m, `plugin/agents/${name}.md has no frontmatter name`);
    assert.equal(m[1], name, `plugin/agents/${name}.md declares name: ${m[1]}`);
  }
});

test('every skill directory matches its SKILL.md frontmatter name', () => {
  for (const name of SKILLS) {
    const fm = readFileSync(join(PLUGIN, 'skills', name, 'SKILL.md'), 'utf8');
    const m = fm.match(/^---\n(?:.*\n)*?name:\s*(\S+)/);
    assert.ok(m, `plugin/skills/${name}/SKILL.md has no frontmatter name`);
    assert.equal(m[1], name, `plugin/skills/${name}/SKILL.md declares name: ${m[1]}`);
  }
});

test('/help lists every shipped skill', () => {
  const help = read('plugin', 'skills', 'help', 'SKILL.md');
  for (const name of SKILLS) {
    assert.ok(
      help.includes(`/learning-loop:${name}`),
      `/help claims to show all commands but omits /learning-loop:${name}`,
    );
  }
});

test('the README skills table lists every shipped skill', () => {
  const readme = read('README.md');
  for (const name of SKILLS) {
    assert.ok(
      new RegExp(`\`/${name}[\\s\`]`).test(readme),
      `README.md's skills table omits /${name}`,
    );
  }
});
