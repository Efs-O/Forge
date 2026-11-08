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
  /** Whether the token being built carries characters that came from quotes or a
   *  backslash. They are data, not grammar: `echo "[["` must not open a test. */
  let tokenQuoted = false;
  let tokenEscaped = false;
  let redirection = false;
  let disqualifiesReadOnly = false;
  /** True between a `>` and the word that names the file it writes into. It
   *  never crosses a statement boundary, so `echo a > b && rm c > d` records
   *  both `b` and `d`, not `c` twice. */
  let pendingRedirectTarget = false;
  /** True between a bash `[[` and its closing `]]`. The test is ONE command whose
   *  operands include `&&` and `||`, so the splitter stays put until it closes:
   *  `[[ -n "$HOME" && -d ~/.forge ]]` used to become `[[ -n "$HOME"` plus
   *  `-d ~/.forge ]]`, and the second statement's program was `-d` (BL-030). Only
   *  `[[` nests: `[ … ]` and `test …` join conditions with `-a`/`-o`, so a real `&&`
   *  after them is a genuine statement break, and PowerShell has no `[[` at all. */
  let insideTest = false;
  /** Words seen in the statement being built, an empty quoted word (`""`) included:
   *  `"" [[ -f a || touch x` already starts with a word, so its `[[` is not a test. */
  let wordsInStatement = 0;
  /** Set when a quote pair closes without adding anything, so that empty word has to be
   *  counted at the next boundary rather than vanish as if it were nothing. */
  let emptyQuotedWord = false;
  const redirects: RedirectTarget[] = [];
  const pushToken = (): void => {
    if (!token) {
      if (emptyQuotedWord) {
        wordsInStatement += 1;
        emptyQuotedWord = false;
        // The word is finished, so its flags are: otherwise the empty pair inside
        // `[[ -z "" ]]` leaves `tokenQuoted` set and the bare `]]` after it is not
        // seen as the test's closer, and the write that follows is swallowed.
        tokenQuoted = false;
        tokenEscaped = false;
      }
      return;
    }
    if (pendingRedirectTarget) {
      redirects.push({ target: token, statementIndex: statements.length - 1 });
      pendingRedirectTarget = false;
    }
    // Only a bare `[[` that opens a statement is the bash test: `echo "[["` hands the
    // characters over as data, `""[[` is one quoted word, and a `[[` after another word
    // is not a test either.
    const opensStatement = wordsInStatement === 0;
    if (shell === 'bash' && !tokenQuoted && !tokenEscaped) {
      if (token === '[[') {
        if (opensStatement) insideTest = true;
      } else if (token === ']]') insideTest = false;
    }
    tokenQuoted = false;
    tokenEscaped = false;
    wordsInStatement += 1;
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
      wordsInStatement = 0;
      emptyQuotedWord = false;
    }
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] ?? '';
    const next = command[i + 1] ?? '';
    if (escaped) {
      // bash: backslash-newline is a line continuation, not a character.
      if (char !== '\n') {
        token += char;
        tokenEscaped = true;
      }
      escaped = false;
      continue;
    }
    if (quote === 'single') {
      if (char === "'") {
        quote = undefined;
        // A quote pair that added nothing is still a word: `"" [[ …` does not open a
        // test, because the empty word comes first.
        if (!token) emptyQuotedWord = true;
      } else {
        token += char;
        tokenQuoted = true;
      }
      continue;
    }
    if (quote === 'double') {
      if (char === '"') {
        quote = undefined;
        if (!token) emptyQuotedWord = true;
      } else if (
        shell === 'bash' &&
        char === '\\' &&
        (next === '$' || next === '`' || next === '"' || next === '\\' || next === '\n')
      ) {
        if (next === '\n') i += 1;
        else escaped = true;
      } else if ((char === '$' && next === '(') || (shell === 'bash' && char === '`')) {
        disqualifiesReadOnly = true;
      } else {
        token += char;
        tokenQuoted = true;
      }
      continue;
    }
    if (quote === 'backtick') {
      token += char;
      tokenQuoted = true;
      quote = undefined;
      continue;
    }
    if (char === "'") {
      quote = 'single';
      tokenQuoted = true;
      continue;
    }
    if (char === '"') {
      quote = 'double';
      tokenQuoted = true;
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
      // A word still in the buffer is finished before the operator is judged: in
      // `[[ -f a ]]&&touch x` the `]]` closes the test, so the `&&` is a break.
      pushToken();
      if (next === '&') {
        if (insideTest) {
          // Inside `[[ … ]]` this is an operand of the test, not a statement break.
          token += '&&';
          i += 1;
          continue;
        }
        pushStatement('other');
        i += 1;
        continue;
      }
      if (shell === 'bash') {
        if (insideTest) {
          token += char;
          continue;
        }
        pushStatement('other');
        continue;
      }
      disqualifiesReadOnly = true;
    }
    if (char === '|' && next === '|') {
      pushToken();
      if (insideTest) {
        token += '||';
        i += 1;
        continue;
      }
      pushStatement('other');
      i += 1;
      continue;
    }
    if (char === '|') {
      pushToken();
      if (insideTest) {
        // `[[ $x =~ a|b ]]` keeps its regular-expression bar inside the test.
        token += char;
        continue;
      }
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
