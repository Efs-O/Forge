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
 * The other half of that pair: a pipeline stage that turns a metadata listing back into
 * the file's bytes, so the listing was a content read after all. PowerShell pipes
 * OBJECTS, so `Get-ChildItem .env | cat` binds the FileInfo to Get-Content and prints
 * the file — `cat`, `gc` and `type` are this machine's aliases for Get-Content
 * (measured with `Get-Alias`) and `sls` is Select-String, which binds pipeline paths
 * too. Bash pipes TEXT, so a listing piped to `head` there shows only names; its
 * contents arrive only when something re-opens the names — and `xargs` is not itself
 * that something, it runs whatever the owner wrote after it, so the program it invokes
 * decides: `ls FILE | xargs echo` prints names, `ls FILE | xargs cat` prints bytes.
 */
const CONTENT_READING_PIPE_PS = new Set([
  'get-content',
  'cat',
  'gc',
  'type',
  'select-string',
  'sls',
]);
/** What `xargs` may be handed that reads the files it is given. A shell is in the list
 *  because `xargs sh -c 'cat $1'` reads them inside it, and asking when the program is
 *  a shell is the fail-safe side of that. */
const XARGS_READERS = new Set([
  'cat',
  'head',
  'tail',
  'sed',
  'awk',
  'more',
  'less',
  'nl',
  'od',
  'strings',
  'tac',
  'tee',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'sort',
  'uniq',
  'wc',
  'tr',
  'cut',
  'fold',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'xxd',
  'hexdump',
  'base64',
  'sh',
  'bash',
  'zsh',
  'dash',
  'pwsh',
  'powershell',
  'cmd',
]);
/** GNU xargs' short options that take a value — read off `xargs --help` on this machine
 *  (findutils 4.10.0, and confirmed by running each form). The value may be attached
 *  (`-n1`) or in the next token (`-n 1`), and options cluster (`-rn 1` is `-r` then
 *  `-n 1`). */
const XARGS_SHORT_VALUE = new Set(['a', 'd', 'E', 'I', 'L', 'n', 'P', 's']);
/** Short options that take nothing: the next character is another option. */
const XARGS_SHORT_SWITCH = new Set(['0', 'o', 'p', 'r', 't', 'x']);
/** Short options whose value is OPTIONAL and only attached (`-eEOF`, `-i{}`): the rest
 *  of the token belongs to them, and the next token is the program it runs. */
const XARGS_SHORT_ATTACHED = new Set(['e', 'i']);
/** xargs' long options that take their value in the NEXT token (`--max-args 1`). */
const XARGS_LONG_SEPARATE_VALUE = [
  '--arg-file',
  '--delimiter',
  '--max-args',
  '--max-chars',
  '--max-procs',
  '--process-slot-var',
];
/** Every long option this file knows, so a prefix resolves the way GNU resolves it:
 *  exactly one match decides, and an ambiguous prefix (`--max-` names four of these)
 *  or an unknown one is left alone. `--max-lines`, `--replace` and `--eof` are here but
 *  not above: their value is optional and only attached, so the word after them is the
 *  program — measured, `xargs --max-lines cat` runs cat and `--max-lines 1 cat` runs 1. */
const XARGS_LONG_OPTIONS = new Set([
  ...XARGS_LONG_SEPARATE_VALUE,
  '--max-lines',
  '--replace',
  '--eof',
  '--null',
  '--interactive',
  '--verbose',
  '--exit',
  '--exit-code',
  '--open-tty',
  '--no-run-if-empty',
  '--show-limits',
  '--help',
  '--version',
]);

/** The program `xargs` will run: its first argument that is not one of its own options,
 *  with an option's value skipped whether it is attached or in its own token. With no
 *  argument it runs `echo`, which prints the names it was given. */
function xargsInvokedProgram(tokens: readonly string[]): string {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      if (equals === -1) {
        const matched = [...XARGS_LONG_OPTIONS].filter((name) => name.startsWith(token));
        if (matched.length === 1 && XARGS_LONG_SEPARATE_VALUE.includes(matched[0] ?? ''))
          index += 1;
      }
      continue; // `--opt=value` carries its value; anything else takes none
    }
    if (token.startsWith('-')) {
      for (let position = 1; position < token.length; position += 1) {
        const option = token[position] ?? '';
        if (XARGS_SHORT_SWITCH.has(option)) continue;
        if (XARGS_SHORT_ATTACHED.has(option)) break; // the rest of the token is its value
        if (!XARGS_SHORT_VALUE.has(option)) break; // an option this file does not know
        if (position + 1 < token.length) break; // the value is attached, as in `-n1`
        index += 1; // the value is the next token
        break;
      }
      continue;
    }
    return baseProgram(token);
  }
  return '';
}

/** Does this pipeline stage read the contents of what the listing handed it? */
export function pipeTargetReadsContents(statement: readonly string[], shell: ShellKind): boolean {
  const program = baseProgram(statement[0] ?? '');
  if (shell === 'bash')
    return program === 'xargs' && XARGS_READERS.has(xargsInvokedProgram(statement));
  return CONTENT_READING_PIPE_PS.has(program);
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
  if (shell === 'bash') {
    const assignments = tokens[0] === 'export' ? tokens.slice(1) : tokens;
    if (
      assignments.length > 0 &&
      assignments.every((token) => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token))
    )
      return true;
  } else if (/^\$[A-Za-z_][A-Za-z0-9_]*$/u.test(tokens[0] ?? '') && tokens[1] === '=') {
    // PowerShell assignment expressions may invoke a read-only pipeline. Judge
    // the command they assign, then let the normal pipeline pass judge its stages.
    return tokens.length > 2 && isReadOnly(tokens.slice(2), shell, cdReadonly);
  }
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
