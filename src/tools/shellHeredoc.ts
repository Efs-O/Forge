import { baseProgram } from './shellCommandTokens';

/**
 * Bash here-documents for `shellPolicy`: a body is the text after the line that
 * opens it, up to its delimiter line. It is stdin for the command, not a
 * command, so `cat > t.test.ts <<'EOF'` writing a test that mentions
 * `rm -rf /` must not be classified as running it.
 */

export interface HeredocBody {
  text: string;
  /** Unquoted delimiter and the body holds `$(` or a backtick: bash runs those while expanding it. */
  expands: boolean;
}

interface Pending {
  delimiter: string;
  stripTabs: boolean;
  quoted: boolean;
}

/** Programs that execute a here-document fed to them as commands. */
const HEREDOC_RUNNERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'source',
  '.',
  'eval',
  'ssh',
  'pwsh',
  'powershell',
]);

/** True when a statement hands its stdin to a shell (`bash <<EOF`, `sudo sh <<EOF`, `ssh host <<EOF`). */
export function feedsHeredocToShell(statement: readonly string[]): boolean {
  return statement.some((token) => HEREDOC_RUNNERS.has(baseProgram(token)));
}

/** Reads the delimiter word after `<<` / `<<-`; returns undefined when there is none. */
function readDelimiter(
  command: string,
  start: number,
): { pending: Pending; end: number } | undefined {
  let index = start;
  const stripTabs = command[index] === '-';
  if (stripTabs) index += 1;
  while (command[index] === ' ' || command[index] === '\t') index += 1;
  let delimiter = '';
  let quoted = false;
  let quote: string | undefined;
  for (; index < command.length; index += 1) {
    const char = command[index] ?? '';
    if (quote) {
      if (char === quote) quote = undefined;
      else delimiter += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
      continue;
    }
    if (char === '\\') {
      quoted = true;
      delimiter += command[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (/[\s;&|<>()]/u.test(char)) break;
    delimiter += char;
  }
  return delimiter ? { pending: { delimiter, stripTabs, quoted }, end: index } : undefined;
}

/**
 * Splits here-document bodies out of a bash command line. `command` keeps every
 * operator and the delimiter words, with each body (and its terminator line)
 * removed, so the parser sees `cat > f <<EOF` and then the next real command.
 */
export function extractHeredocs(command: string): { command: string; bodies: HeredocBody[] } {
  const bodies: HeredocBody[] = [];
  const pending: Pending[] = [];
  let out = '';
  let quote: string | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? '';
    if (quote) {
      out += char;
      if (quote === '"' && char === '\\') out += command[++index] ?? '';
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '\\') {
      out += char + (command[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/u.test(command[index - 1] ?? ''))) {
      // A comment runs to the end of the line; `<<` inside one opens nothing.
      const end = command.indexOf('\n', index);
      const stop = end === -1 ? command.length : end;
      out += command.slice(index, stop);
      index = stop - 1;
      continue;
    }
    if (char === '<' && command[index + 1] === '<' && command[index + 2] === '<') {
      // `<<<` is a here-string: its word is on this line, and nothing follows it.
      out += '<<<';
      index += 2;
      continue;
    }
    if (char === '<' && command[index + 1] === '<') {
      const read = readDelimiter(command, index + 2);
      if (read) {
        pending.push(read.pending);
        out += command.slice(index, read.end);
        index = read.end - 1;
        continue;
      }
    }
    out += char;
    if (char !== '\n' || pending.length === 0) continue;
    // Bodies start on the line after the one that opened them, in opening order.
    let cursor = index + 1;
    for (const doc of pending) {
      const lines: string[] = [];
      while (cursor < command.length) {
        const end = command.indexOf('\n', cursor);
        const stop = end === -1 ? command.length : end;
        const line = command.slice(cursor, stop);
        cursor = stop + 1;
        if ((doc.stripTabs ? line.replace(/^\t+/u, '') : line) === doc.delimiter) break;
        lines.push(line);
      }
      const text = lines.join('\n');
      bodies.push({ text, expands: !doc.quoted && /\$\(|`/u.test(text) });
    }
    pending.length = 0;
    index = cursor - 1;
  }
  return { command: out, bodies };
}
