import { baseProgram } from './shellCommandTokens';

type NestedShellKind = 'bash' | 'pwsh';

/** True for a bash command line containing only variable assignments. Values
 *  may contain command substitutions, whose commands are classified separately. */
export function isBashAssignmentOnly(command: string): boolean {
  let index = 0;
  const skipSpace = (): void => {
    while (/\s/u.test(command[index] ?? '')) index += 1;
  };
  while (index < command.length) {
    skipSpace();
    if (command[index] === ';') {
      index += 1;
      skipSpace();
    }
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/u.exec(command.slice(index));
    if (!assignment) return false;
    index += assignment[0].length;
    const opening = command.slice(index, index + 2);
    if (opening === '$(') {
      let depth = 1;
      index += 2;
      let quote: 'single' | 'double' | undefined;
      let escaped = false;
      while (index < command.length && depth > 0) {
        const char = command[index] ?? '';
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (quote === 'single') {
          if (char === "'") quote = undefined;
        } else if (quote === 'double') {
          if (char === '"') quote = undefined;
        } else if (char === "'") quote = 'single';
        else if (char === '"') quote = 'double';
        else if (char === '(') depth += 1;
        else if (char === ')') depth -= 1;
        index += 1;
      }
      if (depth !== 0) return false;
    } else if (command[index] === '`') {
      index += 1;
      while (index < command.length && command[index] !== '`') index += 1;
      if (command[index] !== '`') return false;
      index += 1;
    } else if (command[index] === "'" || command[index] === '"') {
      const quote = command[index++];
      while (index < command.length && command[index] !== quote) index += 1;
      if (command[index] !== quote) return false;
      index += 1;
    } else {
      while (index < command.length && !/[\s;]/u.test(command[index] ?? '')) index += 1;
    }
    skipSpace();
    if (index < command.length && command[index] !== ';') return false;
  }
  return true;
}

/** Hide a substitution only when it supplies an assignment value; command
 *  substitutions used as commands retain the parser's conservative behavior. */
export function maskBashAssignmentSubstitutions(command: string): string {
  let index = 0;
  let result = '';
  let statementStart = true;
  while (index < command.length) {
    if (statementStart) {
      const whitespace = /^\s+/u.exec(command.slice(index))?.[0];
      if (whitespace) {
        result += whitespace;
        index += whitespace.length;
        continue;
      }
      if (command.startsWith('export ', index)) {
        result += 'export ';
        index += 'export '.length;
        continue;
      }
      const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/u.exec(command.slice(index));
      if (assignment) {
        result += assignment[0];
        index += assignment[0].length;
        if (command.startsWith('$(', index)) {
          let depth = 1;
          index += 2;
          let quote: 'single' | 'double' | undefined;
          let escaped = false;
          while (index < command.length && depth > 0) {
            const char = command[index] ?? '';
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (quote === 'single') {
              if (char === "'") quote = undefined;
            } else if (quote === 'double') {
              if (char === '"') quote = undefined;
            } else if (char === "'") quote = 'single';
            else if (char === '"') quote = 'double';
            else if (char === '(') depth += 1;
            else if (char === ')') depth -= 1;
            index += 1;
          }
          if (depth === 0) result += 'assignment_value';
          else result += command.slice(index - 2);
        } else if (command[index] === '`') {
          index += 1;
          while (index < command.length && command[index] !== '`') index += 1;
          if (command[index] === '`') {
            index += 1;
            result += 'assignment_value';
          }
        }
        statementStart = false;
        continue;
      }
      statementStart = false;
    }
    const char = command[index] ?? '';
    result += char;
    index += 1;
    if (char === ';' || char === '|') statementStart = true;
  }
  return result;
}

/** Expand only literal bash assignments for later statements on this command
 *  line. Runtime values remain opaque so the guards do not guess what the shell
 *  will compute. */
export function expandLiteralBashAssignments(source: readonly (readonly string[])[]): string[][] {
  const variables = new Map<string, string>();
  return source.map((original) => {
    const statement = [...original];
    const assignmentIndex = statement[0] === 'export' ? 1 : 0;
    const assignment = statement[assignmentIndex] ?? '';
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su.exec(assignment);
    if (match && statement.length === assignmentIndex + 1) {
      const [, name = '', value = ''] = match;
      if (!/[$`]/u.test(value)) variables.set(name, value);
      return statement;
    }
    return statement.map((token) =>
      token.replace(
        /\$([A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/gu,
        (raw, named: string) => {
          const name = named.startsWith('{') ? named.slice(1, -1) : named;
          return variables.get(name) ?? raw;
        },
      ),
    );
  });
}

/** A PowerShell block that is only an expression over `$` variables. */
export function isPurePwshExpression(block: string): boolean {
  const unquoted = block.replace(/'[^']*'|"[^"$`]*"/gu, '""').trim();
  return /^\$/u.test(unquoted) && !/[()=;|&{}[\]`]/u.test(unquoted);
}

export interface NestedShellCommand {
  command: string;
  shell: NestedShellKind;
}

/** Remove bash loop/branch syntax so statement classification reaches its command. */
export function executableStatements(statements: readonly (readonly string[])[]): string[][] {
  return statements.flatMap((source) => {
    const statement = [...source];
    while (
      statement.length &&
      ['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{'].includes(
        (statement[0] ?? '').toLowerCase(),
      )
    ) {
      statement.shift();
    }
    if (statement.at(-1) === '}') statement.pop();
    const first = (statement[0] ?? '').toLowerCase();
    if (!statement.length || ['done', 'fi', 'esac'].includes(first)) return [];
    // `for x in ...`, `select x in ...`, and `case x in` are syntax headers.
    if (['for', 'select'].includes(first)) return [];
    if (first === 'case') {
      const arm = statement.findIndex((token) => /^[^()]+\)$/u.test(token));
      if (arm < 0) return [];
      statement.splice(0, arm + 1);
    }
    if (/^[^()]+\)$/u.test(first)) statement.shift();
    while (statement.at(-1) === ';;') statement.pop();
    return statement.length ? [statement] : [];
  });
}

const POSIX_SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);
// Shell options that take the next argument as their value (`bash -o pipefail -c ...`).
const POSIX_VALUE_OPTIONS = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
// Windows PowerShell options that take a value; its first bare argument starts the command.
const POWERSHELL_VALUE_OPTIONS = new Set([
  '-executionpolicy',
  '-ep',
  '-ex',
  '-inputformat',
  '-if',
  '-outputformat',
  '-of',
  '-windowstyle',
  '-w',
  '-psconsolefile',
  '-version',
  '-v',
  '-configurationname',
  '-config',
  '-workingdirectory',
  '-wd',
]);

/** `-c`, `-co`, ... `-command`, `-cwa`, `-commandwithargs`, with `-`, `--` or `/`. */
function isPwshCommandOption(token: string): boolean {
  const name = token.toLowerCase().replace(/^(?:--?|\/)/u, '');
  if (name === token.toLowerCase()) return false;
  return (
    name === 'cwa' || name === 'commandwithargs' || (name.length > 0 && 'command'.startsWith(name))
  );
}
const INTERPRETERS = new Map([
  ['python', new Set(['-c'])],
  ['python2', new Set(['-c'])],
  ['python3', new Set(['-c'])],
  ['node', new Set(['-e', '--eval'])],
  ['perl', new Set(['-e'])],
  ['ruby', new Set(['-e'])],
]);

/** Find shell command strings passed as argv values; interpreter source is deliberately excluded. */
export function extractCommandStrings(
  statements: readonly (readonly string[])[],
): NestedShellCommand[] {
  const found: NestedShellCommand[] = [];
  for (const statement of statements) {
    let index = 0;
    while (index < statement.length) {
      const program = baseProgram(statement[index] ?? '');
      const envOption = statement[index + 1]?.toLowerCase();
      if (program === 'env' && (envOption === '-s' || envOption === '--split-string')) {
        const value = statement[index + 2];
        if (value) found.push({ command: value, shell: 'bash' });
        break;
      }
      if (POSIX_SHELLS.has(program)) {
        for (let arg = index + 1; arg < statement.length; arg += 1) {
          const option = statement[arg] ?? '';
          if (option === '--') break;
          if (POSIX_VALUE_OPTIONS.has(option)) {
            arg += 1;
            continue;
          }
          if (/^[-+]/u.test(option) && option !== '-') {
            if (option === '-c' || (/^-[^-]+$/u.test(option) && option.slice(1).includes('c'))) {
              const value = statement[arg + 1];
              if (value) found.push({ command: value, shell: 'bash' });
              break;
            }
            continue;
          }
          break;
        }
      } else if (program === 'pwsh' || program === 'powershell') {
        for (let arg = index + 1; arg < statement.length; arg += 1) {
          const option = (statement[arg] ?? '').toLowerCase();
          if (isPwshCommandOption(option)) {
            const value = statement[arg + 1];
            if (value) found.push({ command: value, shell: 'pwsh' });
            break;
          }
          if (option === '-encodedcommand' || option === '-enc' || option === '-ec') break;
          if (option === '-file' || option === '-f') break;
          if (POWERSHELL_VALUE_OPTIONS.has(option)) {
            arg += 1;
            continue;
          }
          // Windows PowerShell reads its first bare argument as -Command; pwsh
          // 7 reads it as -File, which runs a script rather than a command string.
          if (!option.startsWith('-')) {
            if (program === 'powershell')
              found.push({ command: statement.slice(arg).join(' '), shell: 'pwsh' });
            break;
          }
        }
      } else if (program === 'cmd') {
        const switchIndex = statement.findIndex(
          (token, arg) => arg > index && /^\/[ck]$/iu.test(token),
        );
        const value = switchIndex >= 0 ? statement[switchIndex + 1] : undefined;
        if (value) found.push({ command: value, shell: 'bash' });
      } else if (program === 'xargs') {
        let arg = index + 1;
        while (arg < statement.length && (statement[arg] ?? '').startsWith('-')) {
          const option = statement[arg] ?? '';
          arg += 1;
          if (['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s'].includes(option)) arg += 1;
        }
        if (arg < statement.length)
          found.push({ command: statement.slice(arg).join(' '), shell: 'bash' });
      } else if (INTERPRETERS.has(program)) {
        // Python/Node/Perl/Ruby code is not shell syntax and must not be substring-scanned.
      }
      index += 1;
    }
  }
  return found;
}
