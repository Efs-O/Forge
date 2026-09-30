import * as fs from 'fs';
import * as path from 'path';
import { inlineScriptStart, PS_LAUNCHERS, SCRIPT_LAUNCHERS } from './execHelpers';
import { checkDenyList, getBuiltinDenyList } from './DenyList';

const MAX_SCRIPT_BYTES = 256 * 1024;
const SCRIPT_EXTENSIONS = new Set(['.ps1', '.sh', '.bat', '.cmd']);
const POWERSHELL_LAUNCHERS = new Set(PS_LAUNCHERS);
const POSIX_LAUNCHERS = new Set(
  SCRIPT_LAUNCHERS.filter((name) => name !== 'cmd' && name !== 'cmd.exe'),
);

/** Check each line of an explicitly enabled inline script on its own. */
export function checkInlineExecScript(command: string, args: string[], enabled: boolean): void {
  const start = inlineScriptStart(command, args);
  if (!enabled || start < 0) return;
  scanText(
    args.slice(start).join(' '),
    (index, denied) =>
      `Inline script line ${index + 1}: blocked by denylist pattern "${denied.description}".` +
      (denied.alternative ? ` ${denied.alternative}` : ''),
  );
}

/** Read and check model-authored script files before any interpreter can run them. */
export function checkExecScriptFile(command: string, args: string[], cwd: string): void {
  const launcher = path.basename(command).toLowerCase();
  const candidates = [
    ...(POWERSHELL_LAUNCHERS.has(launcher) ? scriptArgumentAfter(args, '-file') : []),
    ...(POWERSHELL_LAUNCHERS.has(launcher) ? firstNonOption(args) : []),
    ...interpreterScriptArgument(launcher, args),
    ...args.filter((arg) => SCRIPT_EXTENSIONS.has(path.extname(arg).toLowerCase())),
    ...(SCRIPT_EXTENSIONS.has(path.extname(command).toLowerCase()) ? [command] : []),
  ];
  const scriptPath = candidates.find((candidate) => fs.existsSync(path.resolve(cwd, candidate)));
  if (!scriptPath) return;

  const resolved = path.resolve(cwd, scriptPath);
  const size = fs.statSync(resolved).size;
  if (size > MAX_SCRIPT_BYTES) {
    throw new Error(
      `Script ${scriptPath} is ${size} bytes; exec_command scans scripts up to ${MAX_SCRIPT_BYTES} bytes. ` +
        'Use a smaller script file or the dedicated tools.',
    );
  }
  const bytes = fs.readFileSync(resolved);
  const text = decodeScript(bytes, scriptPath);
  scanText(
    text,
    (index, denied) =>
      `Script ${scriptPath}, line ${index + 1}: blocked — ${denied.description}.` +
      (denied.alternative ? ` ${denied.alternative}` : ''),
  );
}

function interpreterScriptArgument(launcher: string, args: string[]): string[] {
  if (!POSIX_LAUNCHERS.has(launcher)) return [];
  const positional = args.filter((arg) => !arg.startsWith('-'));
  const script =
    launcher === 'busybox' && positional[0]?.toLowerCase() === 'sh' ? positional[1] : positional[0];
  return script ? [script] : [];
}

function firstNonOption(args: string[]): string[] {
  const argument = args.find((arg) => !arg.startsWith('-'));
  return argument ? [argument] : [];
}

function scriptArgumentAfter(args: string[], flag: string): string[] {
  const index = args.findIndex((arg) => arg.toLowerCase() === flag);
  return index >= 0 && args[index + 1] ? [args[index + 1]] : [];
}

function decodeScript(bytes: Buffer, scriptPath: string): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    throw new Error(`Script ${scriptPath} uses unsupported UTF-16BE encoding; it was not scanned.`);
  }
  return bytes.toString('utf8');
}

function scanText(
  text: string,
  message: (index: number, denied: NonNullable<ReturnType<typeof checkDenyList>>) => string,
): void {
  const denyList = getBuiltinDenyList();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    for (const statement of [line, ...splitShellStatements(line)]) {
      const normalized = stripShellPrefixes(statement);
      const denied = checkDenyList(normalized, [], denyList);
      if (denied) throw new Error(message(index, denied));
    }
  }
}

function stripShellPrefixes(statement: string): string {
  let value = statement.trim();
  for (;;) {
    const stripped = value
      .replace(/^(?:(?:(?:then|do|else)\b|!)\s*|[A-Za-z_][A-Za-z0-9_]*=[^\s;|&()]*\s*)+/u, '')
      .trimStart();
    if (stripped === value) return value;
    value = stripped;
  }
}

function splitShellStatements(line: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '\\' && quote !== "'") {
      i += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (
      char === '`' ||
      char === ';' ||
      char === '|' ||
      char === '&' ||
      char === '(' ||
      char === ')'
    ) {
      const statement = line.slice(start, i).trim();
      if (statement) statements.push(statement);
      if ((char === '|' || char === '&') && line[i + 1] === char) i += 1;
      start = i + 1;
    }
  }
  const tail = line.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}
