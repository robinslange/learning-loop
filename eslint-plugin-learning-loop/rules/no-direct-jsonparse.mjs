// rules/no-direct-jsonparse.mjs
// Forbids JSON.parse(readFileSync(...)) outside the allowed helpers.
// Phase 0: configured "off". Phase 1I: flipped to "error" after safeLoad adoption.

const ALLOWED = new Set([
  'scripts/lib/safe-load.mjs',
  'scripts/lib/jsonl.mjs',
]);

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid JSON.parse(fs.readFileSync(...)); use safeLoad() instead.',
    },
    schema: [],
    messages: {
      direct: 'Use safeLoad() from scripts/lib/safe-load.mjs instead of JSON.parse(readFileSync(...)).',
    },
  },
  create(context) {
    const filename = (context.filename || context.getFilename?.() || '').replace(/\\/g, '/');
    if ([...ALLOWED].some((a) => filename.endsWith(a))) return {};
    return {
      CallExpression(node) {
        // Detect JSON.parse(...)
        if (
          node.callee?.type !== 'MemberExpression' ||
          node.callee.object?.name !== 'JSON' ||
          node.callee.property?.name !== 'parse' ||
          node.arguments.length < 1
        ) {
          return;
        }
        const arg = node.arguments[0];
        if (arg?.type !== 'CallExpression') return;
        const callee = arg.callee;
        const isReadFileSync =
          callee?.type === 'Identifier' && callee.name === 'readFileSync';
        const isMemberReadFileSync =
          callee?.type === 'MemberExpression' && callee.property?.name === 'readFileSync';
        if (isReadFileSync || isMemberReadFileSync) {
          context.report({ node, messageId: 'direct' });
        }
      },
    };
  },
};
