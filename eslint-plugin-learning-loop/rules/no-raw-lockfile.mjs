// rules/no-raw-lockfile.mjs
// Forbids direct writes to *.lock paths outside scripts/lib/file-lock.mjs.
// Phase 0: configured "off". Phase 1I: flipped to "error" after migration.

const ALLOWED = new Set(['scripts/lib/file-lock.mjs']);

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid writing directly to *.lock paths; use file-lock.mjs.',
    },
    schema: [],
    messages: {
      raw: 'Use scripts/lib/file-lock.mjs instead of writing to a .lock path directly.',
    },
  },
  create(context) {
    const filename = (context.filename || context.getFilename?.() || '').replace(/\\/g, '/');
    if ([...ALLOWED].some((a) => filename.endsWith(a))) return {};

    const isDotLockLiteral = (n) =>
      n.type === 'Literal' && typeof n.value === 'string' && n.value.endsWith('.lock');

    const concatEndsInDotLock = (n) => {
      if (n.type !== 'BinaryExpression' || n.operator !== '+') return false;
      if (isDotLockLiteral(n.right)) return true;
      if (
        n.right.type === 'TemplateLiteral' &&
        n.right.quasis.at(-1)?.value?.cooked?.endsWith('.lock')
      ) {
        return true;
      }
      return concatEndsInDotLock(n.left);
    };

    const isTemplateEndsInDotLock = (n) =>
      n.type === 'TemplateLiteral' &&
      n.quasis.at(-1)?.value?.cooked?.endsWith('.lock');

    return {
      CallExpression(node) {
        const c = node.callee;
        const name =
          c?.type === 'Identifier'
            ? c.name
            : c?.type === 'MemberExpression'
              ? c.property?.name
              : null;
        if (name !== 'writeFileSync' && name !== 'appendFileSync' && name !== 'openSync') return;
        const arg = node.arguments[0];
        if (!arg) return;
        if (isDotLockLiteral(arg) || concatEndsInDotLock(arg) || isTemplateEndsInDotLock(arg)) {
          context.report({ node, messageId: 'raw' });
        }
      },
    };
  },
};
