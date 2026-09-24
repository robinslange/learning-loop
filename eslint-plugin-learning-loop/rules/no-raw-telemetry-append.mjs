// rules/no-raw-telemetry-append.mjs
// Forbids appendFileSync/createWriteStream outside the jsonl.mjs chokepoint
// and its documented exceptions.
//
// Every offending call site passes a bare variable or a call result
// (logPath, queuePath(), targetPath), so there is no AST-level evidence of
// where the path resolves. That rules out a path-resolution check; this is a
// source-file allowlist instead, the same shape as the `files` glob
// mechanism eslint.config.mjs already uses.

const ALLOWED = new Set([
  'scripts/lib/jsonl.mjs',
  'hooks/modules/autolink.mjs',
  // Vault body writes: different consistency requirements than telemetry.
  'hooks/modules/reflect-track.mjs',
  // Plain-text marker log, not telemetry.
  'scripts/harvest-dedup.mjs',
  // Binary stream, not a JSONL append.
  'scripts/download-binary.mjs',
  // Pid lock file, not telemetry.
  'hooks/lib/common.mjs',
  // Human-readable operational log (librarian.log), read by hand and rotated
  // by log-rotate.mjs. Not a telemetry stream: converting it to JSON lines
  // would make it worse to read for no measurement benefit.
  'scripts/librarian/daemon.mjs',
  // One-byte claim counter: the file size is the count, so O_APPEND is the
  // whole concurrency story. Not telemetry.
  'scripts/lib/fetch-budget.mjs',
]);

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid appendFileSync/createWriteStream for telemetry writes; use appendJsonlLine from scripts/lib/jsonl.mjs.',
    },
    schema: [],
    messages: {
      raw: 'Use appendJsonlLine (or appendJsonlLineDeduped) from scripts/lib/jsonl.mjs instead of appendFileSync/createWriteStream directly.',
    },
  },
  create(context) {
    const filename = (context.filename || context.getFilename?.() || '').replace(/\\/g, '/');
    if ([...ALLOWED].some((a) => filename.endsWith(a))) return {};

    return {
      CallExpression(node) {
        const c = node.callee;
        const name =
          c?.type === 'Identifier'
            ? c.name
            : c?.type === 'MemberExpression'
              ? c.property?.name
              : null;
        if (name !== 'appendFileSync' && name !== 'createWriteStream') return;
        context.report({ node, messageId: 'raw' });
      },
    };
  },
};
