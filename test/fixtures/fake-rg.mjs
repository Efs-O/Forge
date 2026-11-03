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

const contextAt = args.indexOf('--context');
// Real ripgrep's `--json` printer wraps every file in a begin/end pair, so the
// fake sends them too: a fake that only ever emitted match events would let the
// tool ship a crawl that real ripgrep would not have answered the same way.
const contextLines = contextAt !== -1 ? Number(args[contextAt + 1]) : 0;
const ignoreCase = args.includes('--ignore-case');
const fixedStrings = args.includes('--fixed-strings');
// `--flush` (a `--`-prefixed argument the tool never sends, so only a test can
// pass it in `argsPrefix`) puts a real pause between events. Everything the
// fake writes without it lands in one stdout chunk, which is how a tool can
// "finish the page correctly" in a test and get it wrong against a ripgrep that
// streams: a page that ends mid-file, or a kill that lands before the next
// file's first event, is invisible unless the events really do arrive apart.
const flush = args.includes('--flush');

function begin(file) {
  return `${JSON.stringify({ type: 'begin', data: { path: { text: file } } })}
`;
}

function end(file) {
  return `${JSON.stringify({ type: 'end', data: { path: { text: file }, binary_offset: null } })}
`;
}

function event(file, line, text, start = 0) {
  return (
    JSON.stringify({
      type: 'match',
      data: {
        path: { text: file },
        lines: { text: `${text}\n` },
        line_number: line,
        submatches: [{ match: { text: query }, start, end: start + query.length }],
      },
    }) + '\n'
  );
}

// Real ripgrep prints context lines after each match, and never repeats one a
// previous match already printed as trailing context: matches at lines 1 and 4
// with --context 2 print lines 2-3 once, then 5-6.
function context(file, from, count) {
  let out = '';
  for (let i = 0; i < count; i += 1) {
    out +=
      JSON.stringify({
        type: 'context',
        data: {
          path: { text: file },
          lines: { text: `ctx ${from + i}\n` },
          line_number: from + i,
          submatches: [],
        },
      }) + '\n';
  }
  return out;
}

/** One write per event, and a pause so the reader really does see them apart. */
async function emit(chunk) {
  if (!flush) {
    process.stdout.write(chunk);
    return;
  }
  await new Promise((resolve) => process.stdout.write(chunk, 'utf8', resolve));
  await new Promise((resolve) => setTimeout(resolve, 15));
}

/** What real ripgrep prints when nothing matched: a summary line, then exit 1. */
async function finishEmpty() {
  await emit(
    `${JSON.stringify({ type: 'summary', data: { stats: { matched_lines: 0, matches: 0 } } })}\n`,
  );
  process.exit(1);
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
  await emit(`${event('argv.txt', 1, scope.join(' '))}\n`);
} else if (query === 'flag fixture') {
  // The other half of the same trick, for the flags item 1.1 added: `--context`
  // and `--ignore-case` are what the tool promised the model, and a fake that
  // ignored them would pass a test while the real search stayed default.
  const flags = [
    `--context ${contextLines}`,
    ignoreCase ? '--ignore-case' : '--case-sensitive',
    fixedStrings ? '--fixed-strings' : '--regex',
  ];
  await emit(`${event('flags.txt', 1, flags.join(' '))}\n`);
} else if (query === 'count fixture') {
  // Three files with 3, 2 and 1 matching lines, so a test can ask for two of
  // them and check that the counts it gets back are the real ones — the crawl
  // stops at the page limit, and a count that stopped with it would report 1
  // for the last file in the page.
  const corpus = { 'a.ts': 3, 'b.ts': 2, 'c.ts': 1 };
  for (const [file, count] of Object.entries(corpus)) {
    await emit(begin(file));
    for (let line = 1; line <= count; line += 1) {
      await emit(event(file, line, `hit ${line}`));
    }
    await emit(end(file));
  }
} else if (query === 'single fixture') {
  // One file and nothing after it: the page is full and the search really has
  // ended, so a tool that kills on "the page is full" and one that kills on
  // "a file beyond the page" must both say there is nothing left to page to.
  await emit(begin('only.ts'));
  for (let line = 1; line <= 3; line += 1) {
    await emit(event('only.ts', line, `hit ${line}`));
  }
  await emit(end('only.ts'));
} else if (query === 'context fixture') {
  // A file whose matches sit at lines 1 and 4, so the context the tool asked
  // for is visible in the result and `context: 0` really prints match lines
  // only. Matches 1 and 4 with --context 2 print lines 2-3 once, then 5-6.
  await emit(begin('ctx.ts'));
  await emit(event('ctx.ts', 1, 'hit one'));
  await emit(context('ctx.ts', 2, Math.min(contextLines, 2)));
  await emit(event('ctx.ts', 4, 'hit two'));
  await emit(context('ctx.ts', 5, Math.min(contextLines, 2)));
  await emit(end('ctx.ts'));
} else if (query === 'case fixture') {
  // Real ripgrep matches `NEEDLE` for the query `needle` only with --ignore-case,
  // and prints nothing at all without it, so the fake answers the same way.
  if (!ignoreCase) await finishEmpty();
  await emit(`${begin('case.ts')}${event('case.ts', 1, 'NEEDLE two')}${end('case.ts')}`);
} else if (query === 'secret fixture') {
  // Hits that include files the secret gate owns. The tool must drop their lines
  // and say how many it hid — search prints contents, and a secret read by
  // search is a secret read (docs/plans/EXFIL_GATES_PLAN.md, acceptance 3).
  await emit(begin('keep.ts') + event('keep.ts', 2, query) + end('keep.ts'));
  await emit(
    begin('.env') +
      event('.env', 1, 'API_KEY=secret-value') +
      event('.env', 3, 'DATABASE_URL=postgres://secret') +
      end('.env'),
  );
  await emit(
    begin('sub/.env.local') + event('sub/.env.local', 5, 'OTHER=other') + end('sub/.env.local'),
  );
} else if (query === 'only secret') {
  await emit(
    `${begin('.env')}${event('.env', 1, 'API_KEY=secret-value')}${event(
      '.env',
      2,
      'TOKEN=secret',
    )}${end('.env')}`,
  );
} else if (target && path.isAbsolute(target)) {
  const resultPath = fs.statSync(target).isDirectory() ? path.join(target, 'match.py') : target;
  await emit(`${begin(resultPath)}${event(resultPath, 2, query)}${end(resultPath)}`);
} else {
  await emit(`${begin('first.ts')}${event('first.ts', 2, query)}${end('first.ts')}`);
  await emit(`${begin('second.ts')}${event('second.ts', 4, query)}${end('second.ts')}`);
}
