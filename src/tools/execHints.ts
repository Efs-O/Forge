import * as path from 'path';

const EXECUTABLE_EXTENSIONS = /\.[^./\\]+$/u;
const INLINE_SCRIPT_PROGRAMS = new Set([
  'node',
  'python',
  'python3',
  'pwsh',
  'powershell',
  'bash',
  'sh',
]);
const INLINE_SCRIPT_FLAGS = new Set(['-e', '-c', '--eval', '-Command']);

export function describeMisplacedExecArgs(
  toolName: string,
  presentKeys: readonly string[],
): string | undefined {
  if (toolName !== 'exec_command') return undefined;
  if (!presentKeys.some((key) => key === 'execution_id' || key === 'wait_ms')) return undefined;
  return 'these are `monitor_execution` arguments; call that tool to inspect a background execution.';
}

function programStem(command: string): string {
  return path.win32.basename(command).replace(EXECUTABLE_EXTENSIONS, '');
}

export function describeMissingExecutable(
  command: string,
  alternative: string | undefined,
): string | undefined {
  if (!alternative) return undefined;
  if (/[\\/]/u.test(command)) {
    return `no executable at "${command}". ${alternative}`;
  }
  return (
    `"${command}" is not available here: exec_command runs without a shell, ` +
    `so shell builtins have no executable image and Unix utilities are not on this PATH. ${alternative}`
  );
}

export function describeForgeToolProgram(
  command: string,
  registeredToolNames: readonly string[],
): string | undefined {
  const base = programStem(command);
  if (!registeredToolNames.includes(base)) return undefined;
  return `\`${base}\` is a Forge tool; call it directly.`;
}

export function describeWindowsShimSpawnFailure(
  command: string,
  error: unknown,
): string | undefined {
  if (!/\.(cmd|bat)$/iu.test(command)) return undefined;
  if (!(error instanceof Error) || !/\bEINVAL\b/u.test(error.message)) return undefined;
  return (
    `Node cannot launch "${command}" because Windows .cmd and .bat files need a shell. ` +
    'Use `cmd` with `/c` and the command as an explicit program, with ' +
    '`permissions.exec.shell_scripts` enabled.'
  );
}

export function inlineScriptWriteHint(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const base = programStem(command);
  const normalized = platform === 'win32' ? base.toLowerCase() : base;
  const programs =
    platform === 'win32'
      ? new Set([...INLINE_SCRIPT_PROGRAMS].map((name) => name.toLowerCase()))
      : INLINE_SCRIPT_PROGRAMS;
  if (!programs.has(normalized) || !args.some((arg) => INLINE_SCRIPT_FLAGS.has(arg))) {
    return undefined;
  }
  return (
    'Files written by an inline script skip the per-turn checkpoint, so Keep and Undo cannot see them. ' +
    'Prefer `edit_file` or `write_file` for edits.'
  );
}
