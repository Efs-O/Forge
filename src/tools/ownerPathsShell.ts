/**
 * The owner-only wall applied to a shell command line: which token of a
 * statement names a write onto Forge's own files, which folder that token
 * resolves against once the `cd`s earlier in the line are applied, and which
 * `>` lands inside an owner-only root.
 *
 * Split out of `ownerPaths.ts` (2026-11-24) because the two questions have
 * different inputs and different owners. `ownerPaths.ts` answers "is this path
 * owner-only" and knows nothing about how a command line is tokenised; this
 * file answers "does this command line write an owner-only path", and it is the
 * only part of the wall that depends on `shellWritePositions.ts`,
 * `shellReadOnlyRules.ts` and `shellCommandParse.ts`. The path question is still
 * asked of `ownerPaths.ts` and never answered twice here.
 *
 * Importers: `shellPolicy.ts` (the redirect question) and `shellOwnerRule.ts`
 * (the statement and folder questions).
 */
import { isDirectoryChange } from './shellReadOnlyRules';
import { nonWriteArguments } from './shellWritePositions';
import { expandUserTokens, normalizePathForMatch, tokenPathCandidate } from './secretPaths';
import {
  ownerOnlyWriteTargetFor,
  resolveArgumentTarget,
  type OwnerOnlyHit,
  type OwnerOnlySet,
} from './ownerPaths';
import type { RedirectTarget } from './shellCommandParse';

/**
 * The owner-only target a shell statement names, whole tokens only.
 *
 * Same rule as the secret gate: `git rm -f notes.config.yaml` is not a write to
 * `config.yaml`, and a substring rule would refuse every command that mentions
 * the path inside a longer name. The program token is skipped — `Add-Content` is
 * judged by its arguments, not by itself — and an `NAME=value` argument is a
 * variable assignment, not a path (`env FOO=.forge/config.yaml` changes nothing).
 * `nonWriteArguments` skips code positions and copy sources because those are read.
 */
export function ownerOnlyStatementTargetFor(
  tokens: readonly string[],
  set: OwnerOnlySet,
  base?: string,
): OwnerOnlyHit | undefined {
  const positions = nonWriteArguments(tokens);
  const decorate = (hit: OwnerOnlyHit, index: number): OwnerOnlyHit =>
    positions.scriptIndex !== undefined && index > positions.scriptIndex
      ? { ...hit, scriptToken: tokens[positions.scriptIndex] }
      : hit;
  for (const [index, token] of tokens.entries()) {
    // Inline `--target-directory=X` / `-Destination:X` carries the destination;
    // judge that extracted value before the NAME=value skip below.
    const forced = positions.forcedTargets.get(index);
    if (forced !== undefined) {
      const hit = ownerOnlyWriteTargetFor(forced, set, base);
      if (hit) return decorate({ ...hit, supplied: forced }, index);
      continue;
    }
    if (index === 0 || positions.skip.has(index)) continue;
    // A bare PowerShell flag is not a destination (T22, 2026-11-08), but a flag
    // can carry one (`Set-Content -Path:<file>`). Only path-shaped colon values
    // are judged here; `-Encoding:utf8` and `-Force:$true` are not paths.
    if (/^-\p{L}/u.test(token)) {
      const colon = token.indexOf(':');
      if (colon === -1) continue;
      const value = token.slice(colon + 1).replace(/^["']+|["']+$/gu, '');
      if (!(/[\\/]/u.test(value) || /^(?:~|\$HOME|\$env:|[A-Za-z]:)/u.test(value))) continue;
      const forced = tokenPathCandidate(value);
      if (!forced || forced.includes('=')) continue;
      const carried = ownerOnlyWriteTargetFor(forced, set, base);
      if (carried) return decorate({ ...carried, supplied: value }, index);
      continue;
    }
    const candidate = tokenPathCandidate(token);
    if (!candidate || candidate.includes('=')) continue;
    const hit = ownerOnlyWriteTargetFor(candidate, set, base);
    if (hit) return decorate(hit, index);
  }
  return undefined;
}

/**
 * The directory a statement runs in: the folder the command started in, with
 * every `cd` earlier in the same line applied on top, in order (`cd a && cd b`
 * lands in `a/b`, not in `b` read against the start).
 *
 * `undefined` when the line cannot be followed at all — a `cd` whose folder is
 * built at run time, or a relative `cd` with no folder to resolve it against.
 * That is the fail-closed side: the caller then keeps judging the write where it
 * always judged it, at the start, rather than guessing a folder the command may
 * never have reached.
 */
export function effectiveDirectoryFor(
  statements: readonly (readonly string[])[],
  index: number,
  set: OwnerOnlySet,
  base?: string,
): string | undefined {
  let current = base ?? set.workspaceRoot;
  for (let position = 0; position < index; position += 1) {
    const tokens = statements[position]!;
    if (!isDirectoryChange(tokens)) continue;
    // `$HOME`, `%USERPROFILE%` and `~` are the home folder whatever the shell
    // does with them, so they are followed; any other variable is not.
    const dir = expandUserTokens(tokens[1] ?? '', set.home);
    // The same two things `shellReadOnlyRules.ts` refuses to follow a `cd` past:
    // more than one argument, or a path built at run time.
    if (!dir || tokens.length !== 2 || /[$`()%]/u.test(dir)) return undefined;
    const moved = resolveArgumentTarget(dir, set, current);
    if (!moved) return undefined;
    current = moved;
  }
  return current;
}

/** A `>` that lands inside Forge's own files, and how it got there. */
export interface OwnerOnlyRedirect {
  /** The write target, judged from the folder the statement that holds it runs in. */
  hit: OwnerOnlyHit;
  /** The target as the command wrote it, so the refusal can name the write itself. */
  target: string;
  /** True when the write is inside Forge's own files only because a `cd` earlier in the line moved it. That distinction is the whole refusal: the `cd` is what carries a relative `>` into `~/.forge/`. */
  viaCd: boolean;
}

/**
 * The first `>` that lands inside an owner-only root, checked twice because the
 * two answers are two different facts:
 * - against the folder the command started in, which is the ordinary case and
 *   the one the guard has always judged (`echo x > .forge/config.yaml`);
 * - against the folder the `cd`s earlier in the line moved to, which is the case
 *   the guard used to refuse whole commands for. `cd ~/.forge/sessions && ls >
 *   /tmp/out.txt` writes outside Forge's files and was refused as if it wrote
 *   inside them, while `cd ~/.forge/sessions && ls > notes.txt` really does
 *   write inside them and needed a refusal that names the write, not the folder.
 *
 * The start-cwd answer wins when both hold, because that refusal does not need
 * the `cd` explained to it.
 */
export function firstOwnerOnlyRedirect(
  statements: readonly (readonly string[])[],
  redirects: readonly RedirectTarget[],
  set: OwnerOnlySet,
  base?: string,
): OwnerOnlyRedirect | undefined {
  const start = base ?? set.workspaceRoot;
  for (const redirect of redirects) {
    const atStart = ownerOnlyWriteTargetFor(redirect.target, set, start);
    if (atStart) return { hit: atStart, target: redirect.target, viaCd: false };
    if (redirect.statementIndex === 0) continue;
    const moved = effectiveDirectoryFor(statements, redirect.statementIndex, set, start);
    if (!moved || moved === normalizePathForMatch(start ?? '', set.platform)) continue;
    const afterCd = ownerOnlyWriteTargetFor(redirect.target, set, moved);
    if (afterCd) return { hit: afterCd, target: redirect.target, viaCd: true };
  }
  return undefined;
}
