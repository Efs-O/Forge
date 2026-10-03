import * as fs from 'node:fs';
import * as path from 'node:path';

const args = process.argv.slice(2);
const query = args.at(-2);
const target = args.at(-1);
// Real rg reads a bare `--new` as an unknown flag; the pattern must sit behind --regexp.
if (args.at(-3) !== '--regexp') {
  process.stderr.write(`rg: unrecognized flag ${query}
`);
  process.exit(2);
}

function event(file, line, text) {
  return JSON.stringify({
    type: 'match',
    data: { path: { text: file }, lines: { text: `${text}\n` }, line_number: line },
  });
}

if (query === 'slow fixture') {
  setTimeout(() => process.stdout.write(`${event('slow.ts', 1, query)}\n`), 5_000);
} else if (query === 'args fixture') {
  // Echoes the scope-relevant argv back as the match text, so a test can assert
  // the arguments the tool actually passed. The old fixture ignored them, which
  // is how a search could drop every exclusion and still pass its own test
  // (audit F1, 2026-10-03). Kept short on purpose: `capSnippetLine` truncates a
  // match line at 400 chars, and the full argv is longer than that.
  const scope = args.filter((a) => a === '--no-ignore-vcs' || a.startsWith('!'));
  const firstGlob = args.indexOf('--glob');
  if (firstGlob !== -1) scope.unshift(args[firstGlob], args[firstGlob + 1]);
  process.stdout.write(`${event('argv.txt', 1, scope.join(' '))}\n`);
} else if (target && path.isAbsolute(target)) {
  const resultPath = fs.statSync(target).isDirectory() ? path.join(target, 'match.py') : target;
  process.stdout.write(`${event(resultPath, 2, query)}\n`);
} else {
  process.stdout.write(`${event('first.ts', 2, query)}\n`);
  process.stdout.write(`${event('second.ts', 4, query)}\n`);
}
