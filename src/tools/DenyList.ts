/** Whole-token destructive and refused shell rules. */

import { baseProgram, gitCommandTokens } from './shellCommandTokens';

export interface ShellTokenRule {
  match(tokens: readonly string[]): boolean;
  description: string;
  alternative: string;
  class: 'dangerous' | 'refused';
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

export function isRecursiveForceDelete(tokens: readonly string[]): boolean {
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

export function isDestructiveGitCheckout(tokens: readonly string[]): boolean {
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

export function isDestructiveGitPush(tokens: readonly string[]): boolean {
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
  const dangerous = (
    description: string,
    alternative: string,
    match: ShellTokenRule['match'],
  ): ShellTokenRule => ({ class: 'dangerous', description, alternative, match });
  const refused = (
    description: string,
    alternative: string,
    match: ShellTokenRule['match'],
  ): ShellTokenRule => ({ class: 'refused', description, alternative, match });
  return [
    dangerous(
      'recursive force delete',
      'Use delete_file for a specific path.',
      isRecursiveForceDelete,
    ),
    dangerous('git reset --hard', 'Use restore_file for tracked file restoration.', (t) =>
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
      'Use restore_file to restore tracked paths.',
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
    dangerous('recursive Remove-Item', 'Use delete_file for a specific path.', (t) =>
      commandIndexes(t, ['remove-item', 'ri', 'rm']).some(
        (i) => lower(t.slice(i + 1)).includes('-recurse') || lower(t.slice(i + 1)).includes('-r'),
      ),
    ),
    dangerous(
      'process termination',
      'Use stop_execution for Forge jobs; identify other processes before stopping them.',
      (t) => commandIndexes(t, ['stop-process', 'taskkill', 'kill', 'pkill']).length > 0,
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
    ),
    dangerous('recursive rm delete', 'Use delete_file for a specific path.', isRecursiveDelete),
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
