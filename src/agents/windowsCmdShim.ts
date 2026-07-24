/**
 * npm-installed CLIs (claude, codex) ship as `.cmd` shims on Windows, which
 * Node refuses to CreateProcess directly (EINVAL) — they must run through
 * `cmd.exe`. `spawn(..., { shell: true })` looked like the fix but Node does
 * NOT escape array `args` for shell:true (see DEP0190: "arguments are not
 * escaped, only concatenated"), which corrupts any argument containing a
 * space — exactly what task text and workspace paths are. Instead we quote
 * the full command line ourselves (the standard MSVCRT/CommandLineToArgvW
 * quoting rules, the same algorithm Node uses internally for its own
 * argument encoding) and invoke `cmd.exe /d /s /c "<quoted line>"` with
 * `windowsVerbatimArguments: true` so nothing double-escapes it.
 */

/** Quotes one argument for a Windows command line per the MSVCRT rule set. */
export function quoteWindowsArg(arg: string): string {
  if (arg.length > 0 && !/[ \t\n\v"]/.test(arg)) return arg;
  let result = '"';
  for (let i = 0; i <= arg.length; i++) {
    let backslashes = 0;
    while (i < arg.length && arg[i] === '\\') {
      backslashes++;
      i++;
    }
    if (i === arg.length) {
      result += '\\'.repeat(backslashes * 2);
      break;
    } else if (arg[i] === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      result += '\\'.repeat(backslashes) + arg[i];
    }
  }
  return `${result}"`;
}

/** True for `.cmd`/`.bat` shims, which Node cannot CreateProcess directly. */
export function needsWindowsCmdShellWrap(executable: string): boolean {
  return /\.(cmd|bat)$/i.test(executable);
}

/** Builds the `cmd.exe` argv for running `executable args...` through the
 *  shell, fully quoted as one command-line string. */
export function buildWindowsCmdShellInvocation(
  executable: string,
  args: readonly string[],
): { file: string; args: string[] } {
  const commandLine = [executable, ...args].map(quoteWindowsArg).join(' ');
  return { file: process.env['ComSpec'] || 'cmd.exe', args: ['/d', '/s', '/c', commandLine] };
}
