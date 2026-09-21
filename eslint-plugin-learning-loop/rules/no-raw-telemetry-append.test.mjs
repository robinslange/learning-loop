// eslint-plugin-learning-loop/rules/no-raw-telemetry-append.test.mjs
// Lives beside the rule, not under tests/: it needs the `eslint` devDependency,
// and the tests/ suite runs on bare node with no npm install. The lint job,
// which installs dependencies, runs this one.
import { test } from 'node:test';
import { RuleTester } from 'eslint';
import rule from './no-raw-telemetry-append.mjs';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
});

test('no-raw-telemetry-append', () => {
  ruleTester.run('no-raw-telemetry-append', rule, {
    valid: [
      // The chokepoint itself.
      {
        code: "appendFileSync(path, line);",
        filename: '/repo/plugin/scripts/lib/jsonl.mjs',
      },
      // Vault-body writers with different consistency requirements.
      {
        code: "appendFileSync(logPath, body);",
        filename: '/repo/plugin/hooks/modules/autolink.mjs',
      },
      {
        code: "createWriteStream(targetPath).write(body);",
        filename: '/repo/plugin/hooks/modules/reflect-track.mjs',
      },
      // Plain-text marker log.
      {
        code: "appendFileSync(markerPath, marker);",
        filename: '/repo/plugin/scripts/harvest-dedup.mjs',
      },
      // Binary stream.
      {
        code: "createWriteStream(outPath);",
        filename: '/repo/plugin/scripts/download-binary.mjs',
      },
      // Pid lock file.
      {
        code: "appendFileSync(lockPath, String(process.pid));",
        filename: '/repo/plugin/hooks/lib/common.mjs',
      },
      // Unrelated calls in a non-allowlisted file are untouched.
      {
        code: "writeFileSync(logPath, line);",
        filename: '/repo/plugin/scripts/librarian/queue.mjs',
      },
      // daemon.mjs is allowlisted: librarian.log is a human-readable
      // operational log, not a telemetry stream.
      {
        code: 'appendFileSync(logPath, line);',
        filename: '/repo/plugin/scripts/librarian/daemon.mjs',
      },
    ],
    invalid: [
      {
        code: 'appendFileSync(logPath, line);',
        filename: '/repo/plugin/scripts/lib/retrieval.mjs',
        errors: [{ messageId: 'raw' }],
      },
      {
        code: 'createWriteStream(queuePath()).write(line);',
        filename: '/repo/plugin/scripts/librarian/queue.mjs',
        errors: [{ messageId: 'raw' }],
      },
    ],
  });
});
