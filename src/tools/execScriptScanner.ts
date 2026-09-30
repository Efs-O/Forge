import * as fs from 'fs';
import * as path from 'path';
import { checkDenyList, getBuiltinDenyList } from './DenyList';

const MAX_SCRIPT_BYTES = 256 * 1024;
const SCRIPT_EXTENSIONS = new Set(['.ps1', '.sh', '.bat', '.cmd']);
const INLINE_SCRIPT_LAUNCHERS = new Set([
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'bash',
  'sh',
  'zsh',
  'dash',
  'cmd',
  'cmd.exe',
  'busybox',
]);
const INLINE_SCRIPT_FLAGS = new Set(['-command', '-c', '/c']);

/** Check each line of an explicitly enabled inline script on its own. */
export function checkInlineExecScript(command: string, args: string[], enabled: boolean): void {
  if (!enabled || !INLINE_SCRIPT_LAUNCHERS.has(path.basename(command).toLowerCase())) return;
  const flagIndex = args.findIndex((arg) => INLINE_SCRIPT_FLAGS.has(arg.toLowerCase()));
  if (flagIndex < 0) return;
  const script = args.slice(flagIndex + 1).join(' ');
  for (const [index, line] of script.split(/\r?\n/u).entries()) {
    const denied = checkDenyList(line, [], getBuiltinDenyList());
    if (denied) {
      throw new Error(
        `Inline script line ${index + 1}: blocked by denylist pattern "${denied.description}".` +
          (denied.alternative ? ` ${denied.alternative}` : ''),
      );
    }
  }
}

/** Read and check model-authored script files before any interpreter can run them. */
export function checkExecScriptFile(command: string, args: string[], cwd: string): void {
  const candidates = [
    ...(isPowerShell(command) ? scriptArgumentAfter(args, '-file') : []),
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
  const text = fs.readFileSync(resolved, 'utf8');
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const denied = checkDenyList(line, [], getBuiltinDenyList());
    if (denied) {
      throw new Error(
        `Script ${scriptPath}, line ${index + 1}: blocked — ${denied.description}.` +
          (denied.alternative ? ` ${denied.alternative}` : ''),
      );
    }
  }
}

function isPowerShell(command: string): boolean {
  return ['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(
    path.basename(command).toLowerCase(),
  );
}

function scriptArgumentAfter(args: string[], flag: string): string[] {
  const index = args.findIndex((arg) => arg.toLowerCase() === flag);
  return index >= 0 && args[index + 1] ? [args[index + 1]] : [];
}
