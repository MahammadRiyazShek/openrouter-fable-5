/* Runs every check in order. Each script gets its own process so a stubbed
   global set up by one cannot quietly change the outcome of another. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const HERE = import.meta.dirname;
const steps = [
  ['syntax', ['--check', resolve(HERE, '../js/app.js')]],
  ['render', [resolve(HERE, 'render-test.mjs')]],
  ['ingest', [resolve(HERE, 'ingest-test.mjs')]],
  ['api', [resolve(HERE, 'api-test.mjs')]],
  ['boot', [resolve(HERE, 'run.mjs')]],
  ['bundle', [resolve(HERE, 'bundle.mjs')]],
  ['single-file', [resolve(HERE, 'verify-single.mjs')]],
];

let bad = 0;
for (const [label, args] of steps) {
  process.stdout.write(`\n── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}\n`);
  try {
    const out = execFileSync(process.execPath, args, { encoding: 'utf8' });
    process.stdout.write(out.trimEnd() + '\n');
  } catch (e) {
    bad++;
    process.stdout.write((e.stdout || '') + (e.stderr || '') + `\n  ${label} FAILED\n`);
  }
}

console.log(bad ? `\n${bad} step(s) failed` : '\nall steps passed');
process.exitCode = bad ? 1 : 0;
