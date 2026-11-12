import * as fs from 'fs';
import * as path from 'path';
import { foldDrivePath, pathApiFor } from '../util/drivePath';
import { baseProgram, type ShellKind } from './shellCommandTokens';
import { parseCommand } from './shellCommandParse';
import type { RedirectTarget } from './shellCommandParse';
import type { ShellTokenRule } from './DenyList';
import { commandIsAllReadOnly } from './shellReadOnlyRules';

const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_SCRIPT_DEPTH = 3;
const SCRIPT_EXTENSION = /\.(?:ps1|sh|bash|bat|cmd)$/iu;
// The UPS driver chat (2026-11-06..10) started about 12 elevated runs. Three
// were one script rerun because its log sat in C:\Windows\Temp, which the
// unelevated shell cannot read; most others were one admin step per prompt.
export const ELEVATION_RESULT_NOTE =
  'This started an elevated process; Windows asked the owner to confirm it, and only the owner at the PC can. ' +
  'Before starting another elevated process, tell the owner why, and: put every remaining admin step (drivers, services, HKLM, Program Files) in one script, so one prompt covers them; ' +
  'have it write its log where this shell can read it (the workspace or C:\\Users\\Public, never C:\\Windows\\Temp) and read that log before running anything again; ' +
  'and if the same service will need restarting again, grant the owner start and stop rights to it once (sc sdset), so later restarts need no prompt.';

export function appendElevationResultNote(result: string, elevated: boolean | undefined): string {
  return elevated ? `${result}\n${ELEVATION_RESULT_NOTE}` : result;
}

export interface ScriptReadOptions {
  cwd?: string;
  home?: string;
  platform: NodeJS.Platform;
  readScript?: (absPath: string) => string | { error: string };
}

export interface ScriptCommand {
  command: string;
  shell: ShellKind;
  path: string;
}

export interface ScriptCommandsResult {
  scripts: ScriptCommand[];
  error?: string;
}

export type ScriptNestedCommand =
  | (ScriptCommand & { script: true })
  | { command: string; shell: ShellKind; rule: ShellTokenRule };

export function commandStartsElevation(
  command: string,
  shell: ShellKind,
  platform: NodeJS.Platform,
): boolean {
  const statements = parseCommand(command, shell).statements;
  return statements.some((tokens) => {
    const normalized = tokens.map((token) => token.toLowerCase());
    if (normalized.some((token) => baseProgram(token) === 'runas')) return true;
    if (
      platform === 'win32' &&
      normalized.some((token) => ['sudo', 'gsudo'].includes(baseProgram(token)))
    )
      return true;
    return (
      normalized.some((token) => baseProgram(token) === 'start-process') &&
      normalized.some((token, index) => token === '-verb' && normalized[index + 1] === 'runas')
    );
  });
}

export interface ScriptHeredocSource {
  bodies: readonly { text: string; redirectTarget?: string }[];
  redirects: readonly RedirectTarget[];
}

function defaultReadScript(filePath: string): string | { error: string } {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return { error: 'is a directory' };
    if (!stat.isFile()) return { error: 'is not a regular file' };
    if (stat.size > MAX_SCRIPT_BYTES) return { error: `exceeds ${MAX_SCRIPT_BYTES} bytes` };
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return {
      error:
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'does not exist' : 'cannot be read',
    };
  }
}

function scriptPath(token: string): boolean {
  return SCRIPT_EXTENSION.test(token);
}

function bashScriptPath(token: string): boolean {
  const extension = path.extname(token).toLowerCase();
  return !extension || extension === '.sh' || extension === '.bash';
}

function bashScriptArgument(tokens: readonly string[]): string | undefined {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === '--') return tokens[index + 1];
    if (token === '-o' || token === '-O' || token === '--rcfile' || token === '--init-file') {
      index += 1;
      continue;
    }
    if (token === '-c' || token === '--command' || /^-[^-]*c/u.test(token)) return undefined;
    if (token.startsWith('-')) continue;
    return token;
  }
  return undefined;
}

function scriptShell(filePath: string, launcher: ShellKind): ShellKind {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.ps1') return 'pwsh';
  if (extension === '.sh' || extension === '.bash') return 'bash';
  return launcher === 'bash' ? 'bash' : 'pwsh';
}

function resolveScriptPath(token: string, options: ScriptReadOptions): string {
  const api = pathApiFor(options.platform);
  const expanded =
    options.home && /^~(?:[\\/]|$)/u.test(token) ? api.join(options.home, token.slice(2)) : token;
  const folded = foldDrivePath(expanded, options.platform);
  return api.isAbsolute(folded)
    ? api.normalize(folded)
    : api.resolve(options.cwd ?? process.cwd(), folded);
}

function sameScriptPath(left: string, right: string, options: ScriptReadOptions): boolean {
  const leftPath = resolveScriptPath(left, options);
  const rightPath = resolveScriptPath(right, options);
  return options.platform === 'win32'
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

function literalPath(token: string | undefined): token is string {
  return Boolean(token && !/[\s$`(){}]/u.test(token));
}

function bashDrivePathAsTyped(command: string, parsedToken: string): string | undefined {
  const candidates = command.matchAll(/[A-Za-z]:\\[^\s'";|&]+\.(?:ps1|sh|bash|bat|cmd)/giu);
  for (const candidate of candidates) {
    const token = candidate[0];
    const start = candidate.index ?? 0;
    const before = command[start - 1];
    const after = command[start + token.length];
    if ((before === "'" && after === "'") || (before === '"' && after === '"')) continue;
    if (token.replace(/\\(.)/gu, '$1') === parsedToken) return token;
  }
  return undefined;
}

function startProcessTarget(tokens: readonly string[]): string | undefined {
  let filePath: string | undefined;
  let argumentListIndex = -1;
  for (let index = 1; index < tokens.length; index += 1) {
    const option = (tokens[index] ?? '').toLowerCase();
    if (option === '-filepath') filePath = tokens[index + 1];
    else if (option === '-argumentlist') argumentListIndex = index + 1;
    else if (!option.startsWith('-') && filePath === undefined) filePath = tokens[index];
  }
  if (scriptPath(filePath ?? '')) return filePath;
  if (!['powershell', 'pwsh'].includes(baseProgram(filePath ?? ''))) return undefined;
  const args = (argumentListIndex < 0 ? [] : tokens.slice(argumentListIndex)).flatMap((token) =>
    token.split(','),
  );
  for (let index = 0; index < args.length; index += 1) {
    if (/^-file$|^-f$/iu.test(args[index] ?? '') && literalPath(args[index + 1]))
      return args[index + 1];
  }
  return undefined;
}

function launchedPaths(
  command: string,
  shell: ShellKind,
): Array<{ token: string; launcher: ShellKind; statementIndex: number }> {
  const statements = parseCommand(command, shell).statements;
  const found: Array<{ token: string; launcher: ShellKind; statementIndex: number }> = [];
  for (const [statementIndex, statement] of statements.entries()) {
    const tokens = [...statement];
    if (!tokens.length) continue;
    const first = tokens[0] ?? '';
    const program = baseProgram(first);
    let target: string | undefined;
    let launcher = shell;
    if (program === 'powershell' || program === 'pwsh') {
      launcher = 'pwsh';
      for (let index = 1; index < tokens.length; index += 1) {
        if (/^-(?:file|f)$/iu.test(tokens[index] ?? '')) {
          target = tokens[index + 1];
          break;
        }
      }
    } else if (program === 'bash' || program === 'sh') {
      launcher = 'bash';
      const arg = bashScriptArgument(tokens);
      if (arg && bashScriptPath(arg)) target = arg;
    } else if (program === 'cmd' && /^\/(?:c|k)$/iu.test(tokens[1] ?? '')) {
      target = tokens[2];
      launcher = 'pwsh';
    } else if ((first === '&' || first === '.') && tokens[1]) {
      target = tokens[1];
      launcher = shell;
    } else if (scriptPath(first)) {
      target = first;
      launcher = shell;
    } else if (shell !== 'bash' && ['start-process', 'start', 'saps'].includes(program)) {
      target = startProcessTarget(tokens);
      launcher = 'pwsh';
    }
    if (target && (scriptPath(target) || (launcher === 'bash' && !path.extname(target))))
      found.push({ token: target, launcher, statementIndex });
  }
  return found;
}

/** Reads script files named as executable command tokens; it never follows interpreters such as Python or Node. */
export function scriptCommandsFor(
  command: string,
  shell: ShellKind,
  options: ScriptReadOptions,
  heredocSource?: ScriptHeredocSource,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): ScriptCommandsResult {
  const launches = launchedPaths(command, shell);
  const scripts: ScriptCommand[] = [];
  const read = options.readScript ?? defaultReadScript;
  const parsed = parseCommand(command, shell);
  for (const launch of launches) {
    const absolute = resolveScriptPath(launch.token, options);
    const identity = options.platform === 'win32' ? absolute.toLowerCase() : absolute;
    if (seen.has(identity)) continue;
    if (depth >= MAX_SCRIPT_DEPTH)
      return {
        scripts,
        error: `runs a script deeper than the limit (${MAX_SCRIPT_DEPTH}) at ${absolute}`,
      };
    const body = heredocSource?.bodies.find(
      (candidate) =>
        candidate.redirectTarget && sameScriptPath(candidate.redirectTarget, absolute, options),
    );
    const pairedRedirect = body?.redirectTarget;
    const matchingRedirects =
      heredocSource?.redirects.filter((redirect) =>
        sameScriptPath(redirect.target, absolute, options),
      ).length ?? 0;
    const otherRedirect = matchingRedirects > (pairedRedirect ? 1 : 0);
    const otherArgument = parsed.statements.some((statement, index) => {
      if (index === launch.statementIndex) return false;
      const program = baseProgram(statement[0] ?? '');
      if (program === 'chmod' || commandIsAllReadOnly([statement], shell)) return false;
      return statement
        .slice(1)
        .some(
          (token) =>
            sameScriptPath(token, absolute, options) &&
            (!pairedRedirect || !sameScriptPath(token, pairedRedirect, options)),
        );
    });
    if (otherRedirect || otherArgument)
      return { scripts, error: `runs a script this same command changes (${absolute})` };
    const inlineBody = body?.text;
    const content = inlineBody ?? read(absolute);
    if (typeof content !== 'string') {
      const bashPathNote =
        shell === 'bash' ? bashDrivePathAsTyped(command, launch.token) : undefined;
      return {
        scripts,
        error: `runs a script Forge could not read (${absolute}: ${content.error}${
          bashPathNote
            ? `; bash removed the backslashes in ${bashPathNote}: pass shell "pwsh", or write the path with forward slashes`
            : ''
        })`,
      };
    }
    scripts.push({
      command: content,
      shell: scriptShell(launch.token, launch.launcher),
      path: identity,
    });
  }
  return { scripts };
}

export function scriptNestedCommands(
  command: string,
  shell: ShellKind,
  options: ScriptReadOptions,
  heredocSource: ScriptHeredocSource,
  depth: number,
  seen: ReadonlySet<string>,
): ScriptNestedCommand[] {
  const result = scriptCommandsFor(command, shell, options, heredocSource, depth, seen);
  if (result.error)
    return [
      {
        command: '',
        shell,
        rule: {
          match: () => true,
          class: 'dangerous',
          description: result.error,
          alternative: 'Inspect the script and run the reviewed commands directly.',
        },
      },
    ];
  return result.scripts.map((script) => ({ ...script, script: true }));
}
