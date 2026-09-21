// rules/no-empty-catch.mjs
// Forbids bare empty catch blocks that silently swallow errors.
//
// scripts/lib/log.mjs, scripts/lib/safe-load.mjs, and scripts/lib/file-lock.mjs
// intentionally use bare catch blocks as error-absorbing boundaries: log.mjs's
// own fallback path must never throw, and safe-load/file-lock are documented
// best-effort cleanup. Those files are excluded here, the same
// source-file-allowlist shape no-raw-telemetry-append.mjs uses.

const EXCLUDED = new Set([
  'scripts/lib/log.mjs',
  'scripts/lib/safe-load.mjs',
  'scripts/lib/file-lock.mjs',
]);

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
    const filename = (context.filename || context.getFilename?.() || '').replace(/\\/g, '/');
    if ([...EXCLUDED].some((e) => filename.endsWith(e))) return {};

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
