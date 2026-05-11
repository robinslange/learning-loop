// rules/no-empty-catch.mjs
// Forbids bare empty catch blocks that silently swallow errors.
// Phase 0: configured "off". Phase 1I: flipped to "error".
//
// Note: scripts/lib/log.mjs, scripts/lib/safe-load.mjs, and scripts/lib/file-lock.mjs
// intentionally use bare catch blocks as error-absorbing boundaries -- those files
// are in the exclusion list for this rule when 1I enables it.

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid bare catch {} blocks that silently swallow errors.',
    },
    schema: [],
    messages: {
      empty: 'Empty catch swallows errors silently; log via scripts/lib/log.mjs at minimum.',
    },
  },
  create(context) {
    return {
      CatchClause(node) {
        const body = node.body?.body ?? [];
        if (body.length === 0) {
          context.report({ node, messageId: 'empty' });
        }
      },
    };
  },
};
