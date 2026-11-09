/** Whole-token destructive and refused shell rules. */

import * as os from 'os';
import { baseProgram, gitCommandTokens } from './shellCommandTokens';
import { resolvePathForMatch, tokenPathCandidate } from './secretPaths';

export interface ShellTokenRule {
  match(tokens: readonly string[]): boolean;
  description: string;
  alternative: string;
  class: 'dangerous' | 'refused';
  /** The gate that raised this match. `ownerGate` labels a tool-specific gate;
   *  unattended runs refuse it instead of waiting. `denyList` is a K1 stop for
   *  Clanker and a policy refusal for unattended runs; ordinary attended chats
   *  still get the gate's original card or refusal.
   */
  gateKind?: 'ownerGate' | 'denyList';
  /** Which approval key this rule is able to name, if any. `rdelete` marks the
   *  recursive-delete rules whose targets can be read straight out of the command
   *  (`rdeleteTargetsFor` below resolves them), so `approvalKey.ts` can ask for
   *  "recursive deletes inside this folder" instead of a card on every one.
   *
   *  It is a field and not a test on `description`, because rewording a rule is a
   *  one-line change that would otherwise silently change what its call can be
   *  keyed by — and a key that quietly disappears is a card that quietly comes
   *  back, while one that quietly appears is an approval nobody made.
   */
  keyKind?: 'rdelete';
}

const PREFIXES = new Set(['sudo', 'doas', 'command', 'env']);
const lower = (tokens: readonly string[]) => tokens.map((token) => token.toLowerCase());

function commandIndexes(tokens: readonly string[], names: readonly string[]): number[] {
  let index = 0;
  const valueOptions = new Map<string, ReadonlySet<string>>([
    [
      'sudo',
      new Set([
        '-u',
        '-g',
        '-c',
        '-d',
        '-h',
        '-p',
        '-r',
        '-t',
        '--user',
        '--group',
        '--other-user',
        '--close-from',
        '--chdir',
        '--host',
        '--prompt',
        '--role',
        '--type',
        '--command-timeout',
      ]),
    ],
    ['doas', new Set(['-u', '-c'])],
    ['env', new Set(['-u', '-c', '-s', '--unset', '--chdir', '--split-string'])],
  ]);
  while (index < tokens.length) {
    const wrapper = baseProgram(tokens[index] ?? '');
    if (!PREFIXES.has(wrapper)) break;
    index += 1;
    while (index < tokens.length) {
      const token = tokens[index] ?? '';
      if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
        index += 1;
        continue;
      }
      if (token === '--') {
        index += 1;
        break;
      }
      if (!token.startsWith('-') || token === '-') break;
      const option = token.toLowerCase();
      if (valueOptions.get(wrapper)?.has(option)) index += 1;
      index += 1;
      // env -S consumes the rest as one shell command string.
      if (wrapper === 'env' && (option === '-s' || option === '--split-string')) break;
    }
  }
  if (tokens[index] === '&') index += 1;
  const program = baseProgram(tokens[index] ?? '');
  if (names.includes(program)) return [index];
  if (program === 'git' && names.includes((tokens[index + 1] ?? '').toLowerCase()))
    return [index + 1];
  return [];
}

function flags(tokens: readonly string[]): string[] {
  return tokens.filter((token) => token.startsWith('-') || token.startsWith('/'));
}

function isRecursiveForceDelete(tokens: readonly string[]): boolean {
  return commandIndexes(tokens, ['rm']).some((index) => {
    const switches = flags(tokens.slice(index + 1)).map((token) => token.toLowerCase());
    const recursive = switches.some((flag) => flag === '--recursive' || /^-[^-]*r/u.test(flag));
    const force = switches.some((flag) => flag === '--force' || /^-[^-]*f/u.test(flag));
    return recursive && force;
  });
}

function isRecursiveDelete(tokens: readonly string[]): boolean {
  return commandIndexes(tokens, ['rm']).some((index) =>
    flags(tokens.slice(index + 1)).some((flag) => {
      const value = flag.toLowerCase();
      return value === '--recursive' || /^-[^-]*r/u.test(value);
    }),
  );
}

function isDestructiveGitCheckout(tokens: readonly string[]): boolean {
  const index = commandIndexes(tokens, ['git'])[0];
  if (index === undefined) return false;
  const [subcommand, ...rest] = lower(tokens.slice(index + 1));
  if (subcommand === 'restore')
    return !rest.some((token) => token === '--staged' || token === '--cached');
  if (subcommand !== 'checkout') return false;
  const separator = rest.indexOf('--');
  if (separator >= 0) return rest.length > separator + 1;
  return rest.some((token) => token === '.' || token.endsWith('/'));
}

function isDestructiveGitPush(tokens: readonly string[]): boolean {
  const index = commandIndexes(tokens, ['git'])[0];
  if (index === undefined || lower(tokens[index + 1] ? [tokens[index + 1]] : [])[0] !== 'push')
    return false;
  return tokens.slice(index + 2).some((token) => {
    const value = token.toLowerCase();
    return (
      /^--(force|force-with-lease|force-if-includes|delete|mirror|prune)(=|$)/u.test(value) ||
      /^-[a-z]*[fd][a-z]*$/u.test(value) ||
      value.startsWith('+') ||
      (value.startsWith(':') && value.length > 1)
    );
  });
}

export function getBuiltinDenyList(): ShellTokenRule[] {
  // Every deny-list entry carries `gateKind: 'denyList'`: Clanker does not answer
  // these calls, and an unattended run refuses them with the sanctioned tool in
  // `alternative`. A dangerous rule with no safe counterpart must say so explicitly.
  const dangerous = (
    description: string,
    alternative: string,
    match: ShellTokenRule['match'],
    keyKind?: ShellTokenRule['keyKind'],
  ): ShellTokenRule => ({
    class: 'dangerous',
    description,
    alternative,
    gateKind: 'denyList',
    ...(keyKind ? { keyKind } : {}),
    match,
  });
  const refused = (
    description: string,
    alternative: string,
    match: ShellTokenRule['match'],
  ): ShellTokenRule => ({
    class: 'refused',
    description,
    alternative,
    gateKind: 'denyList',
    match,
  });
  return [
    dangerous(
      'recursive force delete',
      'Use delete_file for a specific path.',
      isRecursiveForceDelete,
      'rdelete',
    ),
    dangerous(
      'git reset --hard',
      'Use restore_file to put the tracked paths back to their committed content, ' +
        'or edit_file to undo the edits you made yourself.',
      (t) =>
        commandIndexes(t, ['git']).some(
          (i) => lower(t.slice(i + 1, i + 3)).join(' ') === 'reset --hard',
        ),
    ),
    dangerous('git clean -f', 'Use delete_file for specific paths.', (t) =>
      commandIndexes(t, ['git']).some((i) => {
        const rest = lower(t.slice(i + 1));
        return rest[0] === 'clean' && rest.slice(1).some((flag) => /^-[^-]*f/u.test(flag));
      }),
    ),
    dangerous(
      'git checkout/restore discarding work',
      'To undo edits you made yourself, use edit_file; to put a tracked path back ' +
        'the way git has it, use restore_file.',
      isDestructiveGitCheckout,
    ),
    dangerous(
      'destructive git push',
      'Push without force; remote history changes need explicit user intent.',
      isDestructiveGitPush,
    ),
    dangerous(
      'git rebase rewrites history',
      'Use merge when preserving history is required.',
      (t) =>
        commandIndexes(t, ['git']).some((i) => lower(t[i + 1] ? [t[i + 1]] : [])[0] === 'rebase'),
    ),
    dangerous(
      'git branch -d/-D deletes a branch',
      'Use switch_branch and confirm the intended branch first.',
      (t) =>
        commandIndexes(t, ['git']).some((i) => {
          const rest = lower(t.slice(i + 1));
          return (
            rest[0] === 'branch' &&
            rest.slice(1).some((flag) => flag === '--delete' || /^-[^-]*d/u.test(flag))
          );
        }),
    ),
    dangerous('git stash drop/clear', 'Inspect the stash before removing it.', (t) =>
      commandIndexes(t, ['git']).some((i) => {
        const [subcommand, action] = lower(t.slice(i + 1, i + 3));
        return subcommand === 'stash' && ['drop', 'clear'].includes(action ?? '');
      }),
    ),
    dangerous('git filter-branch rewrites history', 'Use a reviewed git history migration.', (t) =>
      commandIndexes(t, ['git']).some((i) => t[i + 1]?.toLowerCase() === 'filter-branch'),
    ),
    dangerous(
      'git reflog expire removes recovery history',
      'Keep the reflog unless the user explicitly requests cleanup.',
      (t) =>
        commandIndexes(t, ['git']).some(
          (i) => lower(t.slice(i + 1, i + 3)).join(' ') === 'reflog expire',
        ),
    ),
    dangerous('SQL DROP', 'Use a reviewed migration with a backup.', (t) => {
      // Anywhere in the argument: a client is often handed several statements (`BEGIN; DROP ...`).
      const sqlStart = /\bdrop\s+(?:table|database|schema)\b/iu;
      const objectTypes = ['table', 'database', 'schema'];
      const isSplitStatement = (words: readonly string[], index: number): boolean =>
        words[index]?.toLowerCase() === 'drop' &&
        objectTypes.includes(words[index + 1]?.toLowerCase() ?? '');
      if (isSplitStatement(t, 0)) return true;
      const clients = ['psql', 'sqlite3', 'mysql', 'sqlcmd', 'invoke-sqlcmd'];
      return commandIndexes(t, clients).some((index) =>
        t
          .slice(index + 1)
          .some((arg, offset) => sqlStart.test(arg) || isSplitStatement(t, index + 1 + offset)),
      );
    }),
    dangerous(
      'recursive Remove-Item',
      'Use delete_file for a specific path.',
      (t) =>
        commandIndexes(t, ['remove-item', 'ri', 'rm']).some(
          (i) => lower(t.slice(i + 1)).includes('-recurse') || lower(t.slice(i + 1)).includes('-r'),
        ),
      'rdelete',
    ),
    dangerous(
      'PowerShell expression evaluation',
      'Use a reviewed local script file.',
      (t) => commandIndexes(t, ['invoke-expression', 'iex']).length > 0,
    ),
    dangerous(
      'recursive delete',
      'Use delete_file for a specific path.',
      (t) =>
        commandIndexes(t, ['rd', 'rmdir', 'del']).some((i) =>
          lower(t.slice(i + 1)).some((v) => ['/s', '-s', '-r'].includes(v)),
        ) ||
        commandIndexes(t, ['remove-item']).some((i) => lower(t.slice(i + 1)).includes('-recurse')),
      'rdelete',
    ),
    dangerous(
      'recursive rm delete',
      'Use delete_file for a specific path.',
      isRecursiveDelete,
      'rdelete',
    ),
    refused(
      'disk format',
      'Use the operating system disk management UI after confirming the target.',
      (t) => commandIndexes(t, ['format', 'diskpart']).length > 0,
    ),
    refused(
      'system power command',
      'Use sleep_computer for a supported sleep request.',
      (t) =>
        commandIndexes(t, [
          'shutdown',
          'reboot',
          'halt',
          'poweroff',
          'restart-computer',
          'stop-computer',
        ]).length > 0,
    ),
    refused('encoded PowerShell command', 'Pass a readable command or script instead.', (t) =>
      commandIndexes(t, ['pwsh', 'powershell']).some((i) =>
        lower(t.slice(i + 1)).some((v) => ['-encodedcommand', '-enc', '-ec'].includes(v)),
      ),
    ),
    refused(
      'download piped to a shell',
      'Download and inspect the script before running it.',
      (t) =>
        lower(t).some(
          (v, i) =>
            v === '|' && ['sh', 'bash', 'iex', 'invoke-expression'].includes(lower(t)[i + 1] ?? ''),
        ),
    ),
  ].map((rule) => ({
    ...rule,
    match: (tokens: readonly string[]) => rule.match(gitCommandTokens(tokens)),
  }));
}

// ── the recursive-delete key ──────────────────────────────────────────────────

/** The programs the four `keyKind: 'rdelete'` rules match. */
const RDELETE_PROGRAMS = ['rm', 'rd', 'rmdir', 'del', 'remove-item', 'ri'];

/**
 * `Remove-Item`'s switches this matcher understands, and whether each one takes a
 * value. `-Path` and `-LiteralPath` take the next token as a target; `-Recurse` and
 * `-Force` carry none.
 *
 * PowerShell abbreviates parameters (`-rec`, `-fo`, `-p`), and an abbreviation can
 * name a different parameter the day the module adds one, so abbreviations are
 * deliberately NOT here: an unknown switch is the answer that makes the call ask,
 * where a guessed one is an approval the owner never made.
 */
const REMOVE_ITEM_SWITCHES: ReadonlyMap<string, 'flag' | 'value'> = new Map([
  ['-recurse', 'flag'],
  ['-force', 'flag'],
  ['-path', 'value'],
  ['-literalpath', 'value'],
]);

/** `cmd`'s switches for `rd`, `rmdir` and `del`: `/s` recurses, `/q` is quiet. */
const CMD_SWITCHES = new Set(['/s', '-s', '-r', '/q', '-q']);

/**
 * Is this token a path this matcher can read to the end?
 *
 * No run-time expansion (`$`, `%`, a backtick, an opening `(`), no glob (`*`, `?`,
 * `[`), and `~` only at the start — where `resolvePathForMatch` expands it and
 * nowhere else, because a `~` in the middle is either a literal folder name or a
 * spelling this resolver would leave alone and compare as if it were expanded.
 */
function targetIsLiteral(token: string): boolean {
  if (token.length === 0) return false;
  for (const char of ['$', '%', '`', '(', '*', '?', '[']) {
    if (token.includes(char)) return false;
  }
  const firstTilde = token.indexOf('~');
  return firstTilde < 0 || firstTilde === 0;
}

/**
 * The targets of a matched recursive-delete statement, resolved to absolute paths,
 * or undefined when this matcher cannot read them — which is the answer that makes
 * the call ask.
 *
 * A key built from a token the shell may expand into something else would approve a
 * folder the owner never saw, so every unreadable token, every switch this file
 * does not know and every relative token with no folder to resolve against returns
 * undefined rather than a guess. `check` is the same environment the secret and
 * owner-only gates are given (the home `~` expands against, the platform being
 * judged, the folder the command runs in): resolving a relative target against
 * `process.cwd()` instead would be a guess about a folder this command is not in.
 */
export function rdeleteTargetsFor(
  statement: readonly string[],
  check: { home?: string; platform?: NodeJS.Platform; cwd?: string },
): string[] | undefined {
  const index = commandIndexes(statement, RDELETE_PROGRAMS)[0];
  if (index === undefined) return undefined;
  const program = baseProgram(statement[index] ?? '');
  const isRemoveItem = program === 'remove-item' || program === 'ri';
  const isCmdBuiltin = program === 'rd' || program === 'rmdir' || program === 'del';
  const home = check.home ?? os.homedir();
  const platform = check.platform ?? process.platform;
  const rest = statement.slice(index + 1);
  const targets: string[] = [];
  /** `rm --`: after the separator every token is a path, not a switch. */
  let pathsOnly = false;

  const addTarget = (raw: string): boolean => {
    const candidate = tokenPathCandidate(raw);
    if (!targetIsLiteral(candidate)) return false;
    const resolved = resolvePathForMatch(candidate, home, platform, check.cwd);
    if (!resolved) return false;
    targets.push(resolved);
    return true;
  };

  for (let position = 0; position < rest.length; position += 1) {
    const raw = rest[position] ?? '';
    const token = tokenPathCandidate(raw);
    if (token.length === 0) return undefined;
    const folded = token.toLowerCase();
    if (!pathsOnly && token.startsWith('-')) {
      if (isRemoveItem) {
        const shape = REMOVE_ITEM_SWITCHES.get(folded);
        if (shape === undefined) return undefined;
        if (shape === 'flag') continue;
        const next = rest[position + 1];
        if (next === undefined) return undefined;
        position += 1;
        if (!addTarget(next)) return undefined;
        continue;
      }
      if (token === '--') {
        pathsOnly = true;
        continue;
      }
      if (isCmdBuiltin) {
        if (!CMD_SWITCHES.has(folded)) return undefined;
        continue;
      }
      // `rm`'s switches are letters, so `-$path` or `--$(flag)` is not one this
      // matcher can read, and treating it as a path would put a stray word in the
      // target list and widen the folder the key names.
      if (!/^--?[a-z]+$/iu.test(token)) return undefined;
      continue;
    }
    if (!pathsOnly && isCmdBuiltin && token.startsWith('/')) {
      if (!CMD_SWITCHES.has(folded)) return undefined;
      continue;
    }
    if (!addTarget(raw)) return undefined;
  }
  return targets.length > 0 ? targets : undefined;
}
