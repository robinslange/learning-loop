// rules/no-handwritten-trust-envelope.mjs
// Forbids spelling out a trust-boundary delimiter by hand.
//
// A delimiter the wrapped content can NAME is a delimiter it can close. The
// framing spike measured that shape at 4/6 attacks blocked against an
// unguarded control's 5/6 — worse than no guard at all — because the attacker
// closes the tag from inside the content. sealedDelimiters() nonces the tag so
// the content cannot guess the terminator; this rule keeps the next envelope
// from being built without it.

const ALLOWED = new Set(['scripts/lib/origin-envelope.mjs']);

// `<tag ... trust="...">` opening a boundary, or a bare `</tag>` closing one.
const OPEN_RE = /<[a-z][a-z0-9-]*\s[^>]*\btrust\s*=\s*"/i;
const CLOSE_RE = /<\/(?:vault-note|retrieved-context)\s*>/i;

function offends(text) {
  return typeof text === 'string' && (OPEN_RE.test(text) || CLOSE_RE.test(text));
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Build trust-boundary delimiters with sealedDelimiters(), never by hand.',
    },
    schema: [],
    messages: {
      handwritten:
        'Hand-written trust envelope: the wrapped content can name this delimiter and close it. Use sealedDelimiters() from scripts/lib/origin-envelope.mjs.',
    },
  },
  create(context) {
    const filename = (context.filename || context.getFilename?.() || '').replace(/\\/g, '/');
    if ([...ALLOWED].some((a) => filename.endsWith(a))) return {};

    return {
      Literal(node) {
        if (offends(node.value)) context.report({ node, messageId: 'handwritten' });
      },
      TemplateLiteral(node) {
        // Check the static text with expression slots collapsed, so
        // `<tag origin="${o}" trust="untrusted-data">` is still caught.
        const flat = node.quasis.map((q) => q.value.cooked ?? '').join(' ');
        if (offends(flat)) context.report({ node, messageId: 'handwritten' });
      },
    };
  },
};
