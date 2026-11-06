/**
 * Which token lists are read-only invocations: the program table, and the
 * argument checks that stop a read-only program from writing a file or running
 * something. Split out of `shellPolicy.ts` — that file walks a whole command
 * line (deny list, here-documents, nested shells, the secret gate), while this
 * answers one question about one already-split statement.
 */
import { baseProgram, splitGitGlobals, type ShellKind } from './shellCommandTokens';

const READ_ONLY_UNIX = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'grep',
  'rg',
  'find',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'awk',
  'sed',
  'echo',
  'pwd',
  'which',
  'file',
  'stat',
  'du',
  'df',
  'diff',
  'jq',
  'realpath',
  'dirname',
  'basename',
  'date',
  // BL-027: the file-existence checks an agent reaches for when it wants to know
  // whether something is there, not to change it. PowerShell's equivalent
  // `test-path` has always been in `READ_ONLY_PS` (`:52`); these were the bash
  // spellings missing from this table, so `test -f ~/.forge/policy.yaml` was
  // classed as a write and refused with words that said Forge "refuses to
  // change" a file the command never touched. `[` and `[[` are matched as whole
  // programs by `baseProgram` (`shellCommandTokens.ts:8-10`), not as prefixes, so
  // adding them cannot make a program that merely starts with `[` read-only.
  // None of these five can write a file, and `unixArgsReadOnly` answers `true`
  // for a program with no argument rules (`:254-255`), which is what they need.
  'test',
  '[',
  '[[',
  'true',
  'false',
]);
const READ_ONLY_PS = new Set([
  'get-childitem',
  'get-content',
  'get-item',
  'get-location',
  'select-string',
  'select-object',
  'sort-object',
  'group-object',
  'measure-object',
  'format-table',
  'format-list',
  'out-string',
  'test-path',
  'resolve-path',
  'split-path',
  'join-path',
  'get-command',
  'get-process',
  'get-date',
  'convertfrom-json',
  'write-output',
  'ls',
  'dir',
  'cat',
  'type',
  'gci',
  'gc',
  'sls',
  'select',
  'where',
  'sort',
  'measure',
  'echo',
]);
const READ_ONLY_BOTH = new Set(['rg', 'git', 'node', 'npm', 'icacls']);
const METADATA_ONLY_UNIX = new Set(['ls', 'dir', 'stat']);
const METADATA_ONLY_PS = new Set(['ls', 'dir', 'stat', 'test-path', 'get-item', 'get-childitem']);

/** Does this read-only invocation inspect file metadata without printing bytes? */
export function isMetadataOnlyRead(tokens: readonly string[], shell: ShellKind): boolean {
  const program = baseProgram(tokens[0] ?? '');
  return (shell === 'bash' ? METADATA_ONLY_UNIX : METADATA_ONLY_PS).has(program);
}

/**
 * Changing the working directory writes nothing: each shell tool call is its own
 * process, so a `cd` dies with it. They were refused anyway because the read-only
 * table did not name them, which made `cd ~/.forge/agent-bus && ls` — a pure read
 * — cost a card or a refusal. `cdReadonly` says whether this command may count
 * them as reads, and it is only true when NOTHING in the command writes, so
 * `cd ~/.forge && rm x` still judges `rm` a write and still refuses it, and the
 * `cd` itself then names an owner-only path and is refused with it.
 */
const DIRECTORY_CHANGES = new Set(['cd', 'pushd', 'popd', 'sl', 'set-location', 'chdir']);

/** True when every statement in this command reads, `cd` included. Asked with
 *  `cd` allowed, because its own answer depends on the answer. */
export function commandIsAllReadOnly(
  statements: readonly (readonly string[])[],
  shell: ShellKind,
): boolean {
  return statements.every((statement) => isReadOnly(statement, shell, true));
}

/** Is this statement a directory change? `shellPolicy.ts` asks, because a `cd`
 *  refused for a different reason than a write needs different words: the agent
 *  has to see that the `cd` was not the problem, the write after it was. */
export function isDirectoryChange(tokens: readonly string[]): boolean {
  return DIRECTORY_CHANGES.has(baseProgram(tokens[0] ?? ''));
}

/**
 * `git cat-file` prints an object, but two of its switches run the repository's
 * configured programs, so only these four count as a read: `-t` type, `-s`
 * size, `-p` print, `-e` exists.
 */
const CAT_FILE_READ_SWITCHES = new Set([
  '-t',
  '-s',
  '-p',
  '-e',
  '--type',
  '--size',
  '--pretty-print',
  '--eol',
]);
export function isReadOnly(
  tokens: readonly string[],
  shell: ShellKind,
  cdReadonly = false,
): boolean {
  if (tokens.length === 0) return true;
  const program = baseProgram(tokens[0] ?? '');
  if (DIRECTORY_CHANGES.has(program)) {
    // `cd` with more than one argument, or a computed one, is not a directory
    // change this table can follow, so it is not free.
    return cdReadonly && tokens.length === 2 && !/[$`()]/u.test(tokens[1] ?? '');
  }
  const args = tokens.slice(1).map((token) => token.toLowerCase());
  if (READ_ONLY_BOTH.has(program)) {
    if (program === 'node' || program === 'npm')
      return args.length === 1 && args[0] === '--version';
    if (program === 'git') {
      if (!gitArgsReadOnly(tokens.slice(1))) return false;
      const { command, globals, unknownGlobal } = splitGitGlobals(tokens);
      // `-c core.pager=<cmd>` (or an alias, or core.sshCommand) makes any subcommand run a
      // program, and so can a global this check does not know (`--exec-path=<dir>`).
      if (unknownGlobal) return false;
      if (globals.some((token) => /^(?:-c|--config-env)/u.test(token))) return false;
      const [subcommand, ...rest] = command.slice(1).map((token) => token.toLowerCase());
      if (
        [
          'status',
          'diff',
          'log',
          'show',
          'blame',
          'ls-files',
          'rev-parse',
          'describe',
          'grep',
          // Inspect-only subcommands: each prints and changes nothing, so naming
          // `.forge/config.yaml` is reading it, not rewriting it. Being read-only
          // also means no approval card, so each of these is auto-approved.
          'check-ignore',
          'check-attr',
          'ls-tree',
          'show-ref',
          'merge-base',
        ].includes(subcommand ?? '')
      )
        return true;
      if (subcommand === 'cat-file')
        return rest.every((arg) => !arg.startsWith('-') || CAT_FILE_READ_SWITCHES.has(arg));
      if (subcommand === 'branch')
        return rest.every((arg) => ['-a', '-r', '-v', '--list', '--show-current'].includes(arg));
      if (subcommand === 'remote') return rest.join(' ') === '-v';
      if (subcommand === 'config') return rest[0] === '--get';
      return false;
    }
    return unixArgsReadOnly(program, args, tokens.slice(1));
  }
  if (shell === 'bash') {
    if (!READ_ONLY_UNIX.has(program)) return false;
    return unixArgsReadOnly(program, args, tokens.slice(1));
  }
  // Script-block cmdlets are read-only only with a block; the blocks themselves
  // are checked by classifyShellCommand's nested pass (`% Delete` calls a method).
  if (SCRIPT_BLOCK_PS.has(program)) return tokens.slice(1).some((token) => token.includes('{'));
  return READ_ONLY_PS.has(program);
}
const SCRIPT_BLOCK_PS = new Set(['foreach-object', 'where-object', '%', '?', 'foreach']);

/** `[[`'s comparison operators: each makes bash evaluate its operand as
 *  arithmetic, which runs a substitution hidden inside a quoted subscript. */
const ARITHMETIC_OPERAND_SWITCHES = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge']);

/** sed scripts that only print/delete lines or substitute without the `w`/`e` flags. */
const SAFE_SED = /^(?:(?:\d+|\$)(?:,(?:\d+|\$))?[pd]|\d*p|s(.).*\1.*\1[gip\d]*)$/u;

/**
 * `icacls` with no modification switch prints the permissions it was shown and
 * changes nothing. It was refused as a change on 2026-11-02, which is how a read
 * of a file's own ACL cost the agent a round it did not need.
 *
 * Everything outside the list below fails closed, because `/grant`, `/deny`,
 * `/reset`, `/remove`, `/inheritance:r` and `/setowner` all rewrite the ACL, and
 * a rule that matched "starts with a slash" would let a switch this file never
 * heard of through as a read. Git Bash rewrites `/grant` into
 * `C:/Program Files/Git/grant` when the command is run, so a model that wants the
 * switch has to write `//grant`; both spellings reach this check as written, and
 * both are judged as switches — a lone `/word` with no further slash. A token
 * with another slash in it (`/c/Users/someone/.forge/x`) is a path, not a switch.
 */
const ICACLS_READ_SWITCHES = new Set(['t', 'q', 'l', 'c', 'n', 'passive', 'verify', '?']);

/** Is this `icacls` argument a file to list rather than a switch that writes? */
function icaclsArgumentReads(arg: string): boolean {
  if (arg.startsWith('-')) return false;
  const slashes = /^\/{1,2}(.*)$/u.exec(arg);
  if (!slashes) return true; // `C:/…`, `~/…`, `%USERPROFILE%\…` or a bare name
  const rest = slashes[1] ?? '';
  if (rest.includes('/')) return true; // `/c/Users/someone/.forge/x`
  return ICACLS_READ_SWITCHES.has(rest);
}

/** Arguments that make an otherwise read-only Unix program write files or run commands. */
function unixArgsReadOnly(program: string, args: string[], raw: string[]): boolean {
  switch (program) {
    case 'find':
      return !args.some((arg) =>
        [
          '-delete',
          '-exec',
          '-execdir',
          '-ok',
          '-okdir',
          '-fprint',
          '-fprint0',
          '-fprintf',
          '-fls',
        ].includes(arg),
      );
    case 'sed': {
      if (args.some((arg) => /^-[a-z]*i/u.test(arg) || arg.startsWith('--in-place'))) return false;
      // Scripts follow -e; without -e the first operand is the script.
      const scripts = raw.flatMap((arg, index) => (raw[index - 1] === '-e' ? [arg] : []));
      if (scripts.length === 0) scripts.push(raw.find((arg) => !arg.startsWith('-')) ?? '');
      return scripts.every((script) =>
        script.split(';').every((part) => SAFE_SED.test(part.trim())),
      );
    }
    case 'awk':
      // `system()`, pipes and `print > file` run or write; comparisons like `$3 > 9` stay read-only.
      return !raw.some((arg) => /system\s*\(|\||\bprintf?\b[^;}]*>|getline/u.test(arg));
    case 'rg':
      return !args.some((arg) => arg.startsWith('--pre'));
    case 'test':
    case '[':
    case '[[': {
      // BL-027's own blind spot, found on review of the fix: `[[ x -eq y ]]`
      // evaluates its operands as arithmetic and `test -v name` evaluates an
      // array subscript, and both run a `$( … )` written INSIDE a quoted
      // operand — so the nested `$()` pass that catches `test -f "$(rm x)"`
      // has nothing to find. Refuse those shapes, and any operand that carries
      // a `[` subscript or a backtick, rather than class them as reads.
      const closing = program === '[[' ? ']]' : ']';
      const operands = raw.filter((arg, index) => index !== raw.length - 1 || arg !== closing);
      if (operands.some((arg) => arg === '-v' || arg === '-R')) return false;
      if (program === '[[' && operands.some((arg) => ARITHMETIC_OPERAND_SWITCHES.has(arg)))
        return false;
      return !operands.some((arg) => arg.includes('[') || arg.includes('`'));
    }
    case 'icacls':
      return args.every(icaclsArgumentReads);
    case 'sort':
      return !args.some(
        (arg) => arg === '-o' || arg.startsWith('--output') || /^-[a-z]*o/u.test(arg),
      );
    case 'uniq':
      return raw.filter((arg) => !arg.startsWith('-')).length <= 1;
    case 'date':
      return !args.some((arg) => arg === '-s' || arg.startsWith('--set'));
    default:
      return true;
  }
}

/** git flags that write a file or run a configured program (case-sensitive: `-O` is the pager). */
function gitArgsReadOnly(raw: string[]): boolean {
  return !raw.some(
    (arg) =>
      arg.startsWith('--output') ||
      arg.startsWith('--open-files-in-pager') ||
      arg.startsWith('-O') ||
      arg === '--ext-diff',
  );
}
