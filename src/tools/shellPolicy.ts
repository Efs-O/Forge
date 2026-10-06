import { getBuiltinDenyList, type ShellTokenRule } from './DenyList';

export type ShellClass = 'read_only' | 'normal' | 'dangerous' | 'refused';
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

function parseCommand(command: string): ParsedCommand {
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
      token += char;
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
      else if (char === '$' && next === '(') disqualifiesReadOnly = true;
      else token += char;
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
      if (next === '(') disqualifiesReadOnly = true;
      else quote = 'backtick';
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

function baseProgram(value: string): string {
  return (value.split(/[\\/]/u).pop() ?? value).replace(/\.(exe|cmd|bat)$/iu, '').toLowerCase();
}

function isReadOnly(tokens: readonly string[], shell: ShellKind): boolean {
  if (tokens.length === 0) return true;
  const program = baseProgram(tokens[0] ?? '');
  const args = tokens.slice(1).map((token) => token.toLowerCase());
  if (READ_ONLY_BOTH.has(program)) {
    if (program === 'node' || program === 'npm')
      return args.length === 1 && args[0] === '--version';
    if (program === 'git') {
      const [subcommand, ...rest] = args;
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
    return true;
  }
  if (shell === 'bash') {
    if (!READ_ONLY_UNIX.has(program)) return false;
    if (
      program === 'find' &&
      args.some((arg) => ['-delete', '-exec', '-execdir', '-ok'].includes(arg))
    )
      return false;
    if (program === 'sed' && args.some((arg) => arg === '-i' || arg.startsWith('-i'))) return false;
    return true;
  }
  if (['foreach-object', 'where-object'].includes(program)) {
    const source = tokens.slice(1).join(' ');
    const blocks = [...source.matchAll(/\{([^{}]*)\}/gu)].map((match) => match[1] ?? '');
    if (blocks.length === 0) return false;
    return blocks.every((block) => {
      if (/^\s*\$[\w_]+(?:\.[\w]+)*(?:\s|$)/u.test(block)) return true;
      const nested = parseCommand(block);
      return (
        !nested.redirection &&
        !nested.disqualifiesReadOnly &&
        nested.statements.every((part) => isReadOnly(part, shell))
      );
    });
  }
  return READ_ONLY_PS.has(program);
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
    if (quote) {
      if (shell === 'bash' && char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
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
  const parsed = parseCommand(command);
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
  const nestedCommands = nestedShellCommands(command, shell);
  for (const nestedCommand of nestedCommands) {
    const nested = classifyShellCommand(nestedCommand, shell);
    if (nested.classification === 'dangerous' || nested.classification === 'refused') {
      if (precedence(nested.classification) > precedence(strongest.classification))
        strongest = nested;
    }
  }
  for (const statement of parsed.statements) {
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
