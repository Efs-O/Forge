/**
 * Which shell program reaches a host, and what it is called.
 *
 * Split out of `shellPolicy.ts` because the two change for different reasons: the
 * classifier changes when a rule or a parse changes, this table changes when someone
 * finds a program that talks to another machine under a name this file does not
 * know. It is also the half `docs/plans/ASK_ONCE_APPROVALS_PLAN.md` §2 turns into an
 * approval key (`net:prog:curl`), so a key is read out of one table rather than
 * assembled from a set that a classifier happens to have consulted first.
 *
 * The distinction between the two halves of the table is what keeps a build free:
 * `npm run build`, `npm test` and `git status` touch no host, while `npm install`,
 * `git push` and `docker pull` always do. A table that called every `npm` and `git`
 * invocation network-reaching would put a card on the very builds the plan wants
 * uncarded, and a table that called them safe would let `git push` out of a flagged
 * chat unasked.
 */
import { baseProgram } from './shellCommandTokens';

/**
 * Programs that talk to another host on their own, whatever their arguments: a
 * downloader, an interactive remote shell, or a copy to a remote host. Spelled as
 * the plan names them (`curl`, `wget`, `Invoke-WebRequest`, `ssh`, `scp`), plus the
 * PowerShell aliases of the same cmdlet and `sftp`/`rsync`, which do the same job by
 * another name.
 */
const ALWAYS_NETWORK_PROGRAMS = new Set([
  'curl',
  'wget',
  'iwr',
  'invoke-webrequest',
  'invoke-restmethod',
  'ssh',
  'scp',
  'sftp',
  'rsync',
]);

/** PowerShell's alias for a cmdlet, folded to the cmdlet's own name so one program
 *  has one key. `iwr` and `Invoke-WebRequest` are the same thing typed two ways, and
 *  two keys for one program is how a chat gets asked about the same `curl` twice. */
const NETWORK_PROGRAM_NAMES: Readonly<Record<string, string>> = {
  iwr: 'invoke-webrequest',
  irm: 'invoke-restmethod',
};

/**
 * Programs that reach the network only for some of their verbs, and those verbs.
 */
const VERB_NETWORK_PROGRAMS: Record<string, Set<string>> = {
  git: new Set([
    'push',
    'pull',
    'clone',
    'fetch',
    'ls-remote',
    'remote',
    'submodule',
    'cherry-pick',
  ]),
  npm: new Set([
    'install',
    'ci',
    'add',
    'remove',
    'uninstall',
    'update',
    'publish',
    'login',
    'outdated',
    'search',
  ]),
  pnpm: new Set(['install', 'ci', 'add', 'remove', 'update', 'publish']),
  yarn: new Set(['install', 'add', 'remove', 'update', 'publish']),
  npx: new Set(['npx']),
  pip: new Set(['install', 'download', 'upload']),
  twine: new Set(['upload', 'check']),
  docker: new Set(['pull', 'push', 'build']),
  podman: new Set(['pull', 'push', 'build']),
  gh: new Set(['api', 'release']),
};

/**
 * Does this statement name a program that reaches a host, and which one?
 *
 * Whole tokens only, resolved the way the deny list resolves them, so a commit
 * message that merely contains the word `push` is not a network command. The name is
 * the program for a downloader or a remote shell, and `program-verb` for the ones
 * that reach a host only for some verbs (`git push` is `git-push`, `npm publish` is
 * `npm-publish`), because the verb is the half that says whether bytes left: a key
 * for `git` as a whole would have allowed the wrong thing by accident.
 */
export function statementNetworkProgram(statement: readonly string[]): string | undefined {
  const program = baseProgram(statement[0] ?? '');
  if (ALWAYS_NETWORK_PROGRAMS.has(program)) return NETWORK_PROGRAM_NAMES[program] ?? program;
  const verbs = VERB_NETWORK_PROGRAMS[program];
  if (!verbs) return undefined;
  // `npx` runs whatever it is handed, and running it means fetching it.
  if (program === 'npx') return 'npx';
  for (const token of statement.slice(1)) {
    if (token.startsWith('-')) continue;
    const verb = token.toLowerCase();
    return verbs.has(verb) ? `${program}-${verb}` : undefined;
  }
  return undefined;
}
