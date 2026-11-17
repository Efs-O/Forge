/**
 * Hints appended to a command's result. Each one turns a failure the model
 * cannot read on its own into something it can act on: POSIX syntax that ran
 * under PowerShell, or a git command that failed because the machine has no
 * author identity configured.
 *
 * Split out of `shellTool.ts`, which sits at the eslint `max-lines` cap: the
 * hints belong with the text they explain, not with the spawn logic.
 */

import type { ShellKind } from './shellCommandTokens';

const POSIX_ONLY = new Set([
  'head',
  'tail',
  'wc',
  'sed',
  'awk',
  'uniq',
  'xargs',
  'cut',
  'tr',
  'grep',
]);
const GLOB_TAKERS = new Set(['rg', 'grep', 'cat', 'wc', 'head', 'tail']);
/** Names POSIX idioms that fail under PowerShell, such as `sort -rn`; whole
 * tokens only and quoted arguments are ignored. */
export function posixIdioms(command: string): string[] {
  const found = new Set<string>();
  for (const segment of command.split(/\||&&|;/u)) {
    const tokens = segment.trim().split(/\s+/u).filter(Boolean);
    const [head, flag] = tokens;
    if (!head) continue;
    if (POSIX_ONLY.has(head)) found.add(head);
    if (head === 'sort' && flag?.startsWith('-')) found.add(`sort ${flag}`);
    if (head === 'for' && tokens[2] === 'in') found.add('a for … in loop');
    if (GLOB_TAKERS.has(head) && tokens.slice(1).some((t) => t.includes('*') && !/^['"-]/u.test(t)))
      found.add(`${head} with a bare glob`);
  }
  return [...found];
}

export function pwshHint(shell: ShellKind, code: number | null, command: string): string {
  if ((shell !== 'pwsh' && shell !== 'powershell') || code === 0) return '';
  const idioms = posixIdioms(command);
  if (!idioms.length) return '';
  return `\nThis ran in PowerShell, but the command uses POSIX syntax (${idioms.join(', ')}). Rerun it with shell: "bash".`;
}

export const GIT_IDENTITY_HINT =
  'Git has no author identity here. Ask the user for the name and email with ask_user and set them only with their answer; in a scheduled job, stop and report it instead. Never invent one.';

/** The git identity sentence, appended only when `output` is git's own
 * "identity unknown" error — a model that reads that error otherwise tends to
 * invent an identity such as `user.name "Forge"` and commit with it. */
export function gitIdentityHint(output: string): string {
  if (!/(Author|Committer) identity unknown/u.test(output)) return '';
  return `\n${GIT_IDENTITY_HINT}`;
}
