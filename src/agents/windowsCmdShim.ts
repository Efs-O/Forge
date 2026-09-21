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

/** Quotes one argument for a Windows command line per the MSVCRT rule set.
 *
 * NOTE on `cmd /s /c`: the switch strips the FIRST and LAST quote of the whole
 * command line before parsing. That is only safe when the line is wrapped in a
 * matched outer quote pair — see {@link buildWindowsCmdShellInvocation}. If
 * the executable path itself is quoted (a spaced path like
 * `C:\Users\efso office\...`) and there is no outer wrap, `/s` strips the
 * executable's own quotes and cmd runs `C:\Users\efso` as a command.
 */
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
 *  shell, fully quoted as one command-line string.
 *
 * The joined line is wrapped in an OUTER quote pair. `cmd /s /c` strips the
 * first and last quote of the line it is given; with the wrap, those are the
 * outer ones, so the executable's own quotes (a spaced path) survive. Without
 * the wrap, a spaced executable path loses its quotes and cmd tries to run
 * the first path segment as a command — e.g. `C:\Users\efso office\npm\codex.cmd`
 * fails with `'C:\Users\efso' is not recognized`. The outer wrap is the
 * documented `cmd /s /c` contract and is a no-op for quote-free paths.
 */
export function buildWindowsCmdShellInvocation(
  executable: string,
  args: readonly string[],
): { file: string; args: string[] } {
  const inner = [executable, ...args].map(quoteWindowsArg).join(' ');
  return { file: process.env['ComSpec'] || 'cmd.exe', args: ['/d', '/s', '/c', `"${inner}"`] };
}
