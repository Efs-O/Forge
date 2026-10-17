/**
 * npm-installed CLIs (claude, codex) ship as `.cmd` shims on Windows, which
 * Node refuses to CreateProcess directly (EINVAL) — they must run through
 * `cmd.exe`. `spawn(..., { shell: true })` looked like the fix but Node does
 * NOT escape array `args` for shell:true (see DEP0190: "arguments are not
 * escaped, only concatenated"), which corrupts any argument containing a
 * space — exactly what task text and workspace paths are. Instead we build the
 * command line ourselves and invoke `cmd.exe /d /s /c "<line>"` with
 * `windowsVerbatimArguments: true` so nothing double-escapes it.
 *
 * Two parsers read that line, so each argument gets two layers (the scheme
 * cross-spawn uses): MSVCRT quoting for the program's own argv parser, then a
 * caret before every cmd metacharacter, including the quotes themselves, so
 * cmd never enters a quoted state and treats nothing as an operator. The
 * carets are applied twice for arguments, because the shim's `%*` hands the
 * line to cmd a second time. Quoting alone let `x&whoami` run `whoami`.
 */

import * as fs from 'fs';
import * as path from 'path';

const CMD_METACHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

function caretEscape(text: string): string {
  return text.replace(CMD_METACHARACTERS, '^$1');
}

/** Quotes one argument for a Windows command line per the MSVCRT rule set.
 *  On its own this is NOT safe to hand to cmd.exe; see the caret layer in
 *  {@link buildWindowsCmdShellInvocation}. */
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

// npm's cmd-shim ends with one of two launch lines: a node script
//   ... "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
// or a native executable
//   "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
const NPM_NODE_SCRIPT_LINE = /"%_prog%"\s+"%dp0%\\([^"]+)"\s+%\*\s*$/;
const NPM_NATIVE_EXE_LINE = /^"%dp0%\\([^"]+\.exe)"\s+%\*\s*$/i;

/** Reads an npm cmd-shim and returns what it would launch, so the target can
 *  be spawned directly with no cmd.exe in between. Through cmd.exe a line
 *  break ends the command: every multi-line `codex queue --message` arrived
 *  as its first line only. `undefined` when the file is not an npm shim or
 *  its target is missing; the caller then takes the escaped cmd.exe path. */
export function unwrapNpmCmdShim(shimPath: string): { file: string; args: string[] } | undefined {
  let text: string;
  try {
    text = fs.readFileSync(shimPath, 'utf8');
  } catch {
    // Not swallowed: the cmd.exe path runs the same file and reports its error.
    return undefined;
  }
  const lastLine = text.trimEnd().split(/\r?\n/).pop() ?? '';
  const dir = path.dirname(shimPath);
  const script = NPM_NODE_SCRIPT_LINE.exec(lastLine)?.[1];
  if (script !== undefined) {
    const target = path.join(dir, script);
    if (!fs.existsSync(target)) return undefined;
    // The shim's own rule: a node.exe beside it wins, else `node` from PATH.
    const bundledNode = path.join(dir, 'node.exe');
    return { file: fs.existsSync(bundledNode) ? bundledNode : 'node', args: [target] };
  }
  const exe = NPM_NATIVE_EXE_LINE.exec(lastLine)?.[1];
  if (exe !== undefined) {
    const target = path.join(dir, exe);
    return fs.existsSync(target) ? { file: target, args: [] } : undefined;
  }
  return undefined;
}

/** True for `.cmd`/`.bat` shims, which Node cannot CreateProcess directly. */
export function needsWindowsCmdShellWrap(executable: string): boolean {
  return /\.(cmd|bat)$/i.test(executable);
}

/** Builds the `cmd.exe` argv for running `executable args...` through the
 *  shell as one command-line string.
 *
 * The line is wrapped in an OUTER quote pair, the documented `cmd /s /c`
 * contract: `/s` strips the first and last quote of the line, and with the
 * wrap those are the outer ones. Every quote inside is caret-escaped, so a
 * spaced executable path (`C:\Users\efso office\npm\codex.cmd`) is held
 * together by its escaped spaces rather than by quotes.
 */
export function buildWindowsCmdShellInvocation(
  executable: string,
  args: readonly string[],
): { file: string; args: string[] } {
  // cmd.exe ends the command at a line break, whatever the quoting: the rest
  // of that argument and every argument after it were silently dropped.
  const broken = args.findIndex((arg) => /[\r\n]/.test(arg));
  if (broken !== -1) {
    throw new Error(
      `Argument ${broken + 1} for ${executable} contains a line break, which cmd.exe ` +
        'cannot pass to a .cmd/.bat shim. Forge runs npm-installed shims directly; point ' +
        'the CLI setting at the program itself or at its npm shim.',
    );
  }
  const line = [
    caretEscape(executable),
    ...args.map((arg) => caretEscape(caretEscape(quoteWindowsArg(arg)))),
  ].join(' ');
  return { file: process.env['ComSpec'] || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`] };
}
