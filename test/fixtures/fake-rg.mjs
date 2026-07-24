const args = process.argv.slice(2);
const query = args.at(-2);

function event(file, line, text) {
  return JSON.stringify({
    type: 'match',
    data: { path: { text: file }, lines: { text: `${text}\n` }, line_number: line },
  });
}

if (query === 'slow fixture') {
  setTimeout(() => process.stdout.write(`${event('slow.ts', 1, query)}\n`), 5_000);
} else {
  process.stdout.write(`${event('first.ts', 2, query)}\n`);
  process.stdout.write(`${event('second.ts', 4, query)}\n`);
}
