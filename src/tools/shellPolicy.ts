import { getBuiltinDenyList, type ShellTokenRule } from './DenyList';
import { extractHeredocs, feedsHeredocToShell } from './shellHeredoc';
import { baseProgram, splitGitGlobals } from './shellCommandTokens';
import { executableStatements, extractCommandStrings } from './shellCommandStrings';

type ShellClass = 'read_only' | 'normal' | 'dangerous' | 'refused';
export type ShellKind = 'pwsh' | 'powershell' | 'bash';

export interface ShellClassification {
  classification: ShellClass;
  rule?: ShellTokenRule;
}

interface ParsedCommand {
  statements: string[][];
  separators: Array<'pipe' | 'other'>;
  redirection: boolean;
  disqualifiesReadOnly: boolean;
}

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
  'diff',
  'jq',
  'realpath',
  'dirname',
  'basename',
  'date',
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
const READ_ONLY_BOTH = new Set(['rg', 'git', 'node', 'npm']);

function parseCommand(command: string, shell: ShellKind): ParsedCommand {
  const statements: string[][] = [[]];
  const separators: Array<'pipe' | 'other'> = [];
  let token = '';
  let quote: 'single' | 'double' | 'backtick' | undefined;
  let escaped = false;
  let redirection = false;
  let disqualifiesReadOnly = false;
  const pushToken = (): void => {
    if (token) (statements[statements.length - 1]?.push(token), (token = ''));
  };
  const pushStatement = (separator: 'pipe' | 'other'): void => {
    pushToken();
    if (statements[statements.length - 1]?.length) {
      separators.push(separator);
      statements.push([]);
    }
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] ?? '';
    const next = command[i + 1] ?? '';
    if (escaped) {
      // bash: backslash-newline is a line continuation, not a character.
      if (char !== '\n') token += char;
      escaped = false;
      continue;
    }
    if (quote === 'single') {
      if (char === "'") quote = undefined;
      else token += char;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') quote = undefined;
      else if (
        shell === 'bash' &&
        char === '\\' &&
        (next === '$' || next === '`' || next === '"' || next === '\\' || next === '\n')
      ) {
        if (next === '\n') i += 1;
        else escaped = true;
      } else if ((char === '$' && next === '(') || (shell === 'bash' && char === '`')) {
        disqualifiesReadOnly = true;
      } else token += char;
      continue;
    }
    if (quote === 'backtick') {
      token += char;
      quote = undefined;
      continue;
    }
    if (char === "'") {
      quote = 'single';
      continue;
    }
    if (char === '"') {
      quote = 'double';
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
      if (next === '&') {
        pushStatement('other');
        i += 1;
        continue;
      }
      if (shell === 'bash') {
        pushStatement('other');
        continue;
      }
      disqualifiesReadOnly = true;
    }
    if (char === '|' && next === '|') {
      pushStatement('other');
      i += 1;
      continue;
    }
    if (char === '|') {
      pushStatement('pipe');
      continue;
    }
    if (char === ';' || char === '\n') {
      pushStatement('other');
      continue;
    }
    if (char === '>' || char === '<') {
      redirection = true;
      pushToken();
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
    disqualifiesReadOnly,
  };
}

function isReadOnly(tokens: readonly string[], shell: ShellKind): boolean {
  if (tokens.length === 0) return true;
  const program = baseProgram(tokens[0] ?? '');
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
        ].includes(subcommand ?? '')
      )
        return true;
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

/** sed scripts that only print/delete lines or substitute without the `w`/`e` flags. */
const SAFE_SED = /^(?:(?:\d+|\$)(?:,(?:\d+|\$))?[pd]|\d*p|s(.).*\1.*\1[gip\d]*)$/u;

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

/**
 * A PowerShell block that is only an expression over `$` variables, such as
 * `$_.Name -eq "node"`: no calls, assignments, pipes or nested blocks.
 */
function isPureExpression(block: string): boolean {
  const unquoted = block.replace(/'[^']*'|"[^"$`]*"/gu, '""').trim();
  return /^\$/u.test(unquoted) && !/[()=;|&{}[\]`]/u.test(unquoted);
}

function precedence(classification: ShellClass): number {
  return { read_only: 0, normal: 1, dangerous: 2, refused: 3 }[classification];
}

function findBalanced(
  source: string,
  start: number,
  open: string,
  close: string,
  shell: ShellKind,
): { value: string; end: number } | undefined {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (shell === 'bash' && char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close && --depth === 0)
      return { value: source.slice(start + 1, index), end: index };
  }
  return undefined;
}

function nestedShellCommands(command: string, shell: ShellKind): string[] {
  const nested: string[] = [];
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? '';
    const next = command[index + 1] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '$' && next === '(') {
      // `"$(...)"` still runs its command in both shells.
      const block = findBalanced(command, index + 1, '(', ')', shell);
      if (block) (nested.push(block.value), (index = block.end));
      continue;
    }
    if (shell === 'bash' && char === '`' && quote !== "'") {
      const end = command.indexOf('`', index + 1);
      if (end > index) (nested.push(command.slice(index + 1, end)), (index = end));
      continue;
    }
    if (quote) {
      if (shell === 'bash' && char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    // bash: `${VAR}` and `{a,b}` expand words; only `{ cmd; }` groups commands.
    if (shell === 'bash' && char === '{' && !/\s/u.test(next)) continue;
    let opener = char;
    let offset = index;
    if (shell !== 'bash' && char === '$' && next === '(') {
      opener = '(';
      offset = index + 1;
    } else if (shell !== 'bash' && char === '`' && next === '(') {
      opener = '(';
      offset = index + 1;
    }
    if (opener === '{' || opener === '(') {
      const block = findBalanced(command, offset, opener, opener === '{' ? '}' : ')', shell);
      if (block) {
        nested.push(block.value);
        index = block.end;
      }
    }
  }
  return nested;
}

export function classifyShellCommand(command: string, shell: ShellKind): ShellClassification {
  // A here-document body is stdin, not commands, unless a shell reads it or bash expands `$(` in it.
  const heredocs = shell === 'bash' ? extractHeredocs(command) : { command, bodies: [] };
  command = heredocs.command;
  const parsed = parseCommand(command, shell);
  const statements = executableStatements(parsed.statements);
  const rules = getBuiltinDenyList();
  const downloaders = new Set(['curl', 'wget', 'iwr', 'invoke-webrequest']);
  const shellPrograms = new Set(['sh', 'bash', 'iex', 'invoke-expression']);
  const downloadPipe = parsed.separators.some(
    (separator, index) =>
      separator === 'pipe' &&
      downloaders.has(baseProgram(parsed.statements[index]?.[0] ?? '')) &&
      shellPrograms.has(baseProgram(parsed.statements[index + 1]?.[0] ?? '')),
  );
  if (downloadPipe) {
    const rule = rules.find(
      (candidate) =>
        candidate.class === 'refused' && candidate.description === 'download piped to a shell',
    );
    if (rule) return { classification: 'refused', rule };
  }
  let strongest: ShellClassification = { classification: 'read_only' };
  const shellReadsHeredoc = parsed.statements.some((statement) => feedsHeredocToShell(statement));
  const nestedCommands = [
    ...heredocs.bodies.filter((body) => shellReadsHeredoc || body.expands).map((body) => body.text),
    ...nestedShellCommands(command, shell),
    ...extractCommandStrings(parsed.statements),
  ];
  for (const nestedCommand of nestedCommands) {
    const nestedText = typeof nestedCommand === 'string' ? nestedCommand : nestedCommand.command;
    // A block that only compares `$_` properties stays read-only; any other
    // nested command (a call, an assignment) ranks like a top-level one.
    if (shell !== 'bash' && isPureExpression(nestedText)) continue;
    const nested = classifyShellCommand(
      nestedText,
      typeof nestedCommand === 'string' ? shell : nestedCommand.shell,
    );
    if (precedence(nested.classification) > precedence(strongest.classification))
      strongest = nested;
  }
  for (const statement of statements) {
    const rule = rules.find((candidate) => candidate.match(statement));
    const current: ShellClassification = rule
      ? { classification: rule.class, rule }
      : {
          classification:
            parsed.disqualifiesReadOnly || parsed.redirection || !isReadOnly(statement, shell)
              ? 'normal'
              : 'read_only',
        };
    if (precedence(current.classification) > precedence(strongest.classification))
      strongest = current;
  }
  if (parsed.redirection && strongest.classification === 'read_only')
    strongest = { classification: 'normal' };
  return strongest;
}
