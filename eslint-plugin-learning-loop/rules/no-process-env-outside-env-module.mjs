// rules/no-process-env-outside-env-module.mjs
// Forbids direct process.env access outside scripts/lib/env.mjs.
// Phase 0: configured "off". Phase 1I: flipped to "error" after consumers migrate.

const ALLOWED = new Set([
  'scripts/lib/env.mjs',
]);

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid process.env access outside scripts/lib/env.mjs.',
    },
    schema: [],
    messages: {
      forbidden: 'Read environment variables from scripts/lib/env.mjs instead of process.env directly.',
    },
  },
  create(context) {
    const filename = (context.filename || context.getFilename?.() || '').replace(/\\/g, '/');
    if ([...ALLOWED].some((a) => filename.endsWith(a))) return {};
    return {
      MemberExpression(node) {
        // Catch process.env.<prop>
        if (
          node.object?.type === 'MemberExpression' &&
          node.object.object?.name === 'process' &&
          node.object.property?.name === 'env'
        ) {
          context.report({ node, messageId: 'forbidden' });
          return;
        }
        // Catch process.env itself (spread, destructure, assignment target)
        if (
          node.object?.name === 'process' &&
          node.property?.name === 'env'
        ) {
          context.report({ node, messageId: 'forbidden' });
        }
      },
    };
  },
};
