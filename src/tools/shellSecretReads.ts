/**
 * The shell-token half of the secret gate: which arguments of a command name a file
 * the secret list knows, and whether that file can be located.
 *
 * Split out of `secretPaths.ts` at the seam that file's own comments already name:
 * `secretPaths.ts` owns the pattern list and the matcher, and this file asks that
 * matcher of shell statements. They change for different reasons — the list changes
 * when the owner approves another pattern, this file changes when the shell grammar
 * does — and the token scanners are what `shellPolicy.ts` and the shell tool's
 * approval gate consume, so a reader looking for "what does this command read" lands
 * here instead of halfway down a 500-line matcher.
 *
 * `tokenPathCandidate` stays in `secretPaths.ts`, because `ownerPaths.ts`,
 * `shellWritePositions.ts` and the deny list read the same token grammar for other
 * lists: three spellings of one token rule is how `git rm -f README.md` and
 * `git rm -f notes.env.md` got judged differently rather than consistently.
 */
import * as os from 'os';
import {
  matchesSecretPattern,
  resolvePathForMatch,
  secretPathAllowListFor,
  secretPatternsFor,
  tokenPathCandidate,
} from './secretPaths';
import type { ForgeConfig } from '../config/types';
import { baseProgram, type ShellKind } from './shellCommandTokens';
import { isMetadataOnlyRead } from './shellReadOnlyRules';

const PATTERN_PROGRAMS = new Set(['grep', 'egrep', 'fgrep', 'rg']);
const GREP_VALUE_OPTIONS = new Set([
  '-m',
  '-A',
  '-B',
  '-C',
  '-d',
  '-D',
  '--max-count',
  '--after-context',
  '--before-context',
  '--context',
  '--directories',
  '--devices',
  '--include',
  '--exclude',
  '--exclude-from',
  '--exclude-dir',
  '--binary-files',
  '--label',
  '--context-separator',
  '--group-separator',
]);
const RG_VALUE_OPTIONS = new Set([
  '-g',
  '-t',
  '-T',
  '-m',
  '-A',
  '-B',
  '-C',
  '-M',
  '-j',
  '--type',
  '--type-not',
  '--glob',
  '--iglob',
  '--max-count',
  '--context',
  '--after-context',
  '--before-context',
  '--max-columns',
  '--threads',
  '--max-depth',
  '--max-filesize',
  '--sort',
  '--sortr',
  '--engine',
  '--encoding',
  '--color',
  '--colors',
  '--type-add',
  '--type-clear',
]);
/** Argument indexes which are expressions or labels, not file operands. */
function nonPathArguments(
  tokens: readonly string[],
  readsMetadataTarget: boolean,
  shell?: ShellKind,
): Set<number> {
  const result = new Set<number>();
  const program = baseProgram(tokens[0] ?? '');
  if (shell && isMetadataOnlyRead(tokens, shell) && !readsMetadataTarget)
    return new Set(tokens.map((_, index) => index));

  if (PATTERN_PROGRAMS.has(program)) {
    let patternSeen = false;
    let optionsEnded = false;
    const valueOptions = program === 'rg' ? RG_VALUE_OPTIONS : GREP_VALUE_OPTIONS;
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index] ?? '';
      if (optionsEnded) {
        if (!patternSeen) {
          result.add(index);
          patternSeen = true;
        }
        continue;
      }
      if (token === '--') {
        result.add(index);
        optionsEnded = true;
        continue;
      }
      if (token === '-e' || token === '--regexp') {
        result.add(index);
        if (index + 1 < tokens.length) result.add(++index);
        patternSeen = true;
      } else if (token.startsWith('--regexp=')) {
        result.add(index);
        patternSeen = true;
      } else if (token === '-f' || token === '--file') {
        // Unlike -e, a file operand is itself a path and must be scanned.
        result.add(index);
        patternSeen = true;
      } else if (valueOptions.has(token)) {
        result.add(index);
        if (index + 1 < tokens.length) result.add(++index);
      } else if (token.startsWith('-') && token !== '-') {
        // Flags do not take a value. In particular, `-i` must not hide a pattern.
        result.add(index);
      } else if (!patternSeen) {
        result.add(index);
        patternSeen = true;
      }
    }
  }

  if (program === 'select-string') {
    let positionalPatternSeen = false;
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index] ?? '';
      if (/^-Pattern(?::|$)/iu.test(token)) {
        result.add(index);
        positionalPatternSeen = true;
        if (!token.includes(':') && index + 1 < tokens.length) result.add(++index);
      } else if (token.startsWith('-')) {
        result.add(index);
      } else if (!positionalPatternSeen) {
        result.add(index);
        positionalPatternSeen = true;
      }
    }
  }

  if (program === 'git') {
    const subcommand = tokens
      .slice(1)
      .find((token) => !token.startsWith('-'))
      ?.toLowerCase();
    if (subcommand === 'commit' || subcommand === 'tag') {
      for (let index = 1; index < tokens.length; index += 1) {
        const token = tokens[index] ?? '';
        if (token === '-m' || token === '--message') {
          result.add(index);
          if (index + 1 < tokens.length) result.add(++index);
        } else if (token.startsWith('--message=') || (token.startsWith('-m') && token.length > 2)) {
          result.add(index);
        } else if ((token === '-F' || token === '--file') && tokens[index + 1] === '-') {
          result.add(index + 1);
          index += 1;
        }
      }
    }
  }

  return result;
}

/**
 * The first token of a statement that reads a secret path, the pattern that matched
 * it, and how many such tokens the statement has — the count is what tells a caller
 * whether this command can be keyed by ONE file at all.
 *
 * Whole tokens only: `git rm -f notes.env.md` is not a `.env` secret, and a substring
 * rule would have made every command that mentions `.env` inside a longer name ask for
 * approval (docs/CLAUDE.md, Agent-Ergonomics Traps).
 *
 * With a `resolve`, a token named relative to the folder the command runs in is
 * compared against an allow entry naming the same file absolutely — `cat .env` in a
 * workspace whose `.env` the owner allowed, the re-run finding 3 again. Without one
 * only the spelling inside the token is compared, which is what a window with no
 * folder open gets, and what the taint question gets either way.
 */
function firstSecretTokenIn(
  tokens: readonly string[],
  patterns: readonly string[],
  options: {
    home: string;
    platform: NodeJS.Platform;
    allow: readonly string[];
    shell?: ShellKind;
    resolve?: (value: string) => string | undefined;
    readsMetadataTarget?: boolean;
  },
): { pattern: string; candidate: string; total: number } | undefined {
  let total = 0;
  let first: { pattern: string; candidate: string } | undefined;
  const ignored = nonPathArguments(tokens, options.readsMetadataTarget === true, options.shell);
  for (let index = 1; index < tokens.length; index += 1) {
    if (
      /^\$(?:_|[A-Za-z][\w]*)\.[A-Za-z_][\w]*$/u.test(tokens[index] ?? '') &&
      tokens[index + 1]?.toLowerCase() === '-match'
    ) {
      ignored.add(index + 1);
      if (index + 2 < tokens.length) ignored.add(index + 2);
    }
    if (ignored.has(index)) continue;
    const token = tokens[index] ?? '';
    // PowerShell's `$_.Key` member expressions are values, not
    // paths. A real path still has a separator after the variable reference.
    if (/^\$(?:_|[A-Za-z][\w]*)\.[A-Za-z_][\w]*$/u.test(token)) continue;
    const candidate = tokenPathCandidate(token);
    if (!candidate || candidate.includes('=')) continue;
    const matched = matchesSecretPattern(candidate, patterns, options);
    if (!matched) continue;
    total += 1;
    if (!first) first = { pattern: matched, candidate };
  }
  return first ? { ...first, total } : undefined;
}

/**
 * Does this shell statement read one of the secret paths?
 *
 * The single-statement question, kept as its own entry point because its tests pin
 * the matcher statement by statement (`test/unit/SecretPaths.test.ts`), and because
 * `shellStatementReadsSecret` is the question `secretPaths.ts` has always answered.
 */
export function shellStatementReadsSecret(
  tokens: readonly string[],
  patterns: readonly string[],
  options: {
    home?: string;
    platform?: NodeJS.Platform;
    allow?: readonly string[];
    shell?: ShellKind;
    /** The folder the command runs in, so a relative token can be recognised as the
     *  absolute path the owner put on the allow list. */
    cwd?: string;
  } = {},
): string | undefined {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  return firstSecretTokenIn(tokens, patterns, {
    home,
    platform,
    allow: options.allow ?? [],
    ...(options.shell ? { shell: options.shell } : {}),
    ...(options.cwd
      ? { resolve: (value: string) => resolvePathForMatch(value, home, platform, options.cwd) }
      : {}),
  })?.pattern;
}

/**
 * Which statements of one command read a path the secret gate knows: the pattern
 * that matched, plus the one file when the command reads exactly one secret file and
 * this matcher can say where it is.
 *
 * It keeps the COUNT as well as the pattern, because an approval key has to name one
 * file: a command that reads two secret files has no single file to name, so its card
 * stays unkeyable rather than being answered by a rule for whichever file the matcher
 * happened to find first. A file is named only when its token can be located —
 * absolute, or relative to the folder the command runs in — never guessed, because a
 * key naming the wrong file is an approval the owner gave to a different file.
 *
 * Asked twice with the same code, and the two answers are not the same: `honorAllowList`
 * true is the CARD question (a path the owner put in `permissions.secret_paths_allow`
 * asks for nothing), false is the TAINT question (that same path still marks the chat,
 * because the escape hatch is for the prompt, not for the exfil rule).
 */
export function secretReadInStatements(
  statements: readonly (readonly string[])[],
  options: {
    config?: ForgeConfig;
    home?: string;
    platform?: NodeJS.Platform;
    /** The folder the command runs in, so a relative token can be located. */
    cwd?: string;
    honorAllowList: boolean;
    shell?: ShellKind;
    /** Statements whose metadata operand flows to a content-reading pipe. */
    readsMetadataTargets?: ReadonlySet<number>;
  },
): { pattern: string; file?: string; count: number } | undefined {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const patterns = secretPatternsFor(options.config);
  const allow = options.honorAllowList ? secretPathAllowListFor(options.config, home) : [];
  const scan = {
    home,
    platform,
    allow,
    ...(options.cwd
      ? { resolve: (value: string) => resolvePathForMatch(value, home, platform, options.cwd) }
      : {}),
  };
  let total = 0;
  let first: { pattern: string; candidate: string } | undefined;
  for (const [index, statement] of statements.entries()) {
    const read = firstSecretTokenIn(statement, patterns, {
      ...scan,
      ...(options.shell ? { shell: options.shell } : {}),
      readsMetadataTarget: options.readsMetadataTargets?.has(index) === true,
    });
    if (!read) continue;
    total += read.total;
    if (!first) first = { pattern: read.pattern, candidate: read.candidate };
  }
  if (!first) return undefined;
  const file =
    total === 1 ? resolvePathForMatch(first.candidate, home, platform, options.cwd) : undefined;
  return { pattern: first.pattern, ...(file ? { file } : {}), count: total };
}
