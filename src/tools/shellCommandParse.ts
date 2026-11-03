/**
 * The command-line parser, split out of `shellPolicy.ts`: this answers
 * "what statements, what separators, is anything redirected into a file, can this
 * still be called a read" and knows nothing about deny lists, secrets or the
 * owner guard. Split because `shellPolicy.ts` reached the 500-line hard stop
 * (`.eslintrc.json` max-lines) the moment `cd` joined the read-only table, and
 * a parser is a real seam: the classifier above it consumes its output and never
 * writes to it.
 */
import type { ShellKind } from './shellCommandTokens';

/**
 * A file a `>` writes into, and the statement it sits in.
 *
 * The statement is not decoration: `cd ~/.forge/sessions && ls > notes.txt` and
 * `cd ~/.forge/sessions && ls > /tmp/notes.txt` look the same to a list of
 * targets, and they are not the same command — the first creates a file inside
 * Forge's own folder, the second outside it. The guard cannot answer which
 * without knowing which directory the redirect ran in, so the parse records it
 * and `ownerPaths.ts` resolves the folder from the `cd`s earlier in the line.
 */
export interface RedirectTarget {
  target: string;
  /** Zero-based index of the statement holding this `>`, into `statements`. */
  statementIndex: number;
}

export interface ParsedCommand {
  statements: string[][];
  separators: Array<'pipe' | 'other'>;
  redirection: boolean;
  /**
   * The files a `>` or `>>` writes into, recorded apart from `redirection`
   * because a redirection is not always a write to the thing the command also
   * names: `cat .forge/config.yaml > backup.txt` reads one path and writes the
   * other, and only the second is the write. A `<` is a read, so its target is
   * not recorded.
   */
  redirects: RedirectTarget[];
  disqualifiesReadOnly: boolean;
}

export function parseCommand(command: string, shell: ShellKind): ParsedCommand {
  const statements: string[][] = [[]];
  const separators: Array<'pipe' | 'other'> = [];
  let token = '';
  let quote: 'single' | 'double' | 'backtick' | undefined;
  let escaped = false;
  let redirection = false;
  let disqualifiesReadOnly = false;
  /** True between a `>` and the word that names the file it writes into. It
   *  never crosses a statement boundary, so `echo a > b && rm c > d` records
   *  both `b` and `d`, not `c` twice. */
  let pendingRedirectTarget = false;
  const redirects: RedirectTarget[] = [];
  const pushToken = (): void => {
    if (!token) return;
    if (pendingRedirectTarget) {
      redirects.push({ target: token, statementIndex: statements.length - 1 });
      pendingRedirectTarget = false;
    }
    statements[statements.length - 1]?.push(token);
    token = '';
  };
  const pushStatement = (separator: 'pipe' | 'other'): void => {
    // Push first: in `echo x > f; ls` the `;` ends the word `f`, and clearing the
    // flag before that push lost `f` as a write target (2026-11-02 red-team).
    pushToken();
    pendingRedirectTarget = false;
    if (statements[statements.length - 1]?.length) {
      separators.push(separator);
      statements.push([]);
    }
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] ?? '';
    const next = command[i + 1] ?? '';
    if (escaped) {
      // bash: backslash-newline is a line continuation, not a character.
      if (char !== '\n') token += char;
      escaped = false;
      continue;
    }
    if (quote === 'single') {
      if (char === "'") quote = undefined;
      else token += char;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') quote = undefined;
      else if (
        shell === 'bash' &&
        char === '\\' &&
        (next === '$' || next === '`' || next === '"' || next === '\\' || next === '\n')
      ) {
        if (next === '\n') i += 1;
        else escaped = true;
      } else if ((char === '$' && next === '(') || (shell === 'bash' && char === '`')) {
        disqualifiesReadOnly = true;
      } else token += char;
      continue;
    }
    if (quote === 'backtick') {
      token += char;
      quote = undefined;
      continue;
    }
    if (char === "'") {
      quote = 'single';
      continue;
    }
    if (char === '"') {
      quote = 'double';
      continue;
    }
    if (char === '`') {
      // bash: command substitution, classified separately by nestedShellCommands.
      if (shell === 'bash' || next === '(') disqualifiesReadOnly = true;
      if (shell === 'bash') {
        token += char;
        continue;
      } else quote = 'backtick';
      continue;
    }
    if (shell === 'bash' && char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '$' && next === '(') {
      disqualifiesReadOnly = true;
      token += '$(';
      i += 1;
      continue;
    }
    if (char === '&') {
      if (next === '&') {
        pushStatement('other');
        i += 1;
        continue;
      }
      if (shell === 'bash') {
        pushStatement('other');
        continue;
      }
      disqualifiesReadOnly = true;
    }
    if (char === '|' && next === '|') {
      pushStatement('other');
      i += 1;
      continue;
    }
    if (char === '|') {
      pushStatement('pipe');
      continue;
    }
    if (char === ';' || char === '\n') {
      pushStatement('other');
      continue;
    }
    if (char === '>' || char === '<') {
      redirection = true;
      // The push above happens first, so the operand before the operator is not
      // mistaken for the file being written (`2>` redirects, and `2` is not a
      // path). Only `>` writes; a `<` feeds the command.
      pushToken();
      if (char === '>') pendingRedirectTarget = true;
      if (next === char) i += 1;
      continue;
    }
    if (/\s/u.test(char)) {
      pushToken();
      continue;
    }
    token += char;
  }
  pushToken();
  return {
    statements: statements.filter((statement) => statement.length),
    separators,
    redirection,
    redirects,
    disqualifiesReadOnly,
  };
}
