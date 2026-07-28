// rules/no-url-pathname.mjs
// Forbids `new URL(...).pathname` as a filesystem path.
//
// On Windows a file URL's pathname is `/D:/a/proj/x.mjs`, and Node resolves
// that leading slash against the drive root, yielding `D:\D:\a\proj\x.mjs`.
// Every consumer then fails with ERR_MODULE_NOT_FOUND / ENOENT. It is correct
// on POSIX, so the bug is invisible to anyone not running the Windows job.
//
// fileURLToPath() is the portable spelling and handles both platforms.

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid new URL(...).pathname for filesystem paths; use fileURLToPath().',
    },
    schema: [],
    messages: {
      pathname:
        'Use fileURLToPath(new URL(...)) instead of .pathname — on Windows .pathname yields "/D:/..." which resolves to "D:\\D:\\...".',
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (node.property?.name !== 'pathname') return;
        const obj = node.object;
        if (obj?.type !== 'NewExpression') return;
        if (obj.callee?.name !== 'URL') return;
        context.report({ node, messageId: 'pathname' });
      },
    };
  },
};
