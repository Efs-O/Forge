import { baseProgram } from './shellCommandTokens';

type NestedShellKind = 'bash' | 'pwsh';
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
