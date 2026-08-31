// tests/eslint-no-handwritten-trust-envelope.test.mjs
// The delimiter is only unforgeable while every envelope comes from
// sealedDelimiters(). A hand-written `<tag trust="untrusted-data">` is a
// guessable terminator, and that is exactly the shape the framing spike
// measured as worse than no guard at all. The rule makes the next one a lint
// error instead of a review finding.
import { test } from 'node:test';
import { RuleTester } from 'eslint';
import rule from '../eslint-plugin-learning-loop/rules/no-handwritten-trust-envelope.mjs';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
});

test('no-handwritten-trust-envelope', () => {
  ruleTester.run('no-handwritten-trust-envelope', rule, {
    valid: [
      {
        code: "const { open, close } = sealedDelimiters('vault-note', 'trust=\"untrusted-data\"');",
      },
      { code: "const s = 'this text mentions trust but builds no tag';" },
      { code: 'lines.push(open); lines.push(close);' },
      // The helper itself is where the delimiter is allowed to be spelled out.
      {
        code: 'const open = `<${tag}-${nonce} trust="untrusted-data">`;',
        filename: '/repo/plugin/scripts/lib/origin-envelope.mjs',
      },
      // A trust attribute the model is not asked to treat as a boundary.
      { code: "const meta = { trust: 'untrusted-data' };" },
    ],
    invalid: [
      {
        code: 'lines.push(\'<vault-note trust="untrusted-data">\');',
        errors: [{ messageId: 'handwritten' }],
      },
      {
        code: "lines.push('</vault-note>');",
        errors: [{ messageId: 'handwritten' }],
      },
      {
        code: 'const open = `<retrieved-context origin="${o}" trust="untrusted-data">`;',
        errors: [{ messageId: 'handwritten' }],
      },
      {
        code: "const close = '</retrieved-context>';",
        errors: [{ messageId: 'handwritten' }],
      },
    ],
  });
});
