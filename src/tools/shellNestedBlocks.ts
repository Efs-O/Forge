import type { ShellKind } from './shellCommandTokens';

/**
 * The quote-aware scan of a raw command line that returns the text inside shell
 * grouping syntax: a `$( … )` substitution in either shell, a bash backtick
 * block, a `{ … }` command group, a pwsh `` `(...) `` group. It parses nothing —
 * statements and redirection targets are `shellCommandParse.ts`, command strings
 * inside a program's arguments are `shellCommandStrings.ts` — it only answers
 * which substrings are themselves commands, so `shellPolicy.ts` can classify
 * each one on its own. Quote state is the whole point: a `{` inside
 * `Write-Output "{ Remove-Item -Recurse }"` is data and opens nothing.
 */
function findBalanced(
  source: string,
  start: number,
  open: string,
  close: string,
  shell: ShellKind,
): { value: string; end: number } | undefined {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (shell === 'bash' && char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close && --depth === 0)
      return { value: source.slice(start + 1, index), end: index };
  }
  return undefined;
}

export function nestedShellCommands(command: string, shell: ShellKind): string[] {
  const nested: string[] = [];
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? '';
    const next = command[index + 1] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '$' && next === '(') {
      // `"$(...)"` still runs its command in both shells.
      const block = findBalanced(command, index + 1, '(', ')', shell);
      if (block) (nested.push(block.value), (index = block.end));
      continue;
    }
    if (shell === 'bash' && char === '`' && quote !== "'") {
      const end = command.indexOf('`', index + 1);
      if (end > index) (nested.push(command.slice(index + 1, end)), (index = end));
      continue;
    }
    if (quote) {
      if (shell === 'bash' && char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    // bash: `${VAR}` and `{a,b}` expand words; only `{ cmd; }` groups commands.
    if (shell === 'bash' && char === '{' && !/\s/u.test(next)) continue;
    let opener = char;
    let offset = index;
    if (shell !== 'bash' && char === '$' && next === '(') {
      opener = '(';
      offset = index + 1;
    } else if (shell !== 'bash' && char === '`' && next === '(') {
      opener = '(';
      offset = index + 1;
    }
    if (opener === '{' || opener === '(') {
      const block = findBalanced(command, offset, opener, opener === '{' ? '}' : ')', shell);
      if (block) {
        nested.push(block.value);
        index = block.end;
      }
    }
  }
  return nested;
}
