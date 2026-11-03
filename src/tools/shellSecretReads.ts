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
    resolve?: (value: string) => string | undefined;
  },
): { pattern: string; candidate: string; total: number } | undefined {
  let total = 0;
  let first: { pattern: string; candidate: string } | undefined;
  for (const token of tokens.slice(1)) {
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
  for (const statement of statements) {
    const read = firstSecretTokenIn(statement, patterns, scan);
    if (!read) continue;
    total += read.total;
    if (!first) first = { pattern: read.pattern, candidate: read.candidate };
  }
  if (!first) return undefined;
  const file =
    total === 1 ? resolvePathForMatch(first.candidate, home, platform, options.cwd) : undefined;
  return { pattern: first.pattern, ...(file ? { file } : {}), count: total };
}
