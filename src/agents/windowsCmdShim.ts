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
import { CliAgentError } from './CliAgentError';
import { systemProbe } from '../tools/execProgramResolver';

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

/**
 * A shim names its target with `\`. Windows' `path.join` splits on either
 * separator, POSIX's only on `/`, so normalise before joining.
 */
function toPathSeparators(shimRelative: string): string {
  return shimRelative.replace(/\\/g, '/');
}

/** Seam for locating the program an npm shim needs, so a unit test never
 *  spawns `where.exe` or reads a real tree. */
export interface ShimNodeLookupDeps {
  exists?: (candidate: string) => boolean;
  /** Searches `pathValue` for `program` and returns its full path, or
   *  `undefined`. Defaults to `systemProbe().which` in
   *  `src/tools/execProgramResolver.ts` — the repo's only synchronous
   *  `where.exe` probe — with `pathValue` in the probe's own environment block,
   *  because `where` follows the PATH it is handed, not the caller's: that is
   *  what makes a refreshed PATH usable here. Injected so a unit test never
   *  spawns it. */
  which?: (program: string, pathValue: string) => string | undefined;
}

/** Locates the Node that runs an npm shim's node script, in the order npm's own
 *  cmd-shim uses it: a `node.exe` beside the shim wins (npm puts one there when
 *  the package ships its own runtime), otherwise `node.exe` on `pathValue` —
 *  normally the refreshed Windows PATH from `windowsUserPath.ts`, so the
 *  launcher is found the way a freshly opened terminal would find it — and then
 *  a refusal that names the fix.
 *
 *  It never returns the bare name `node`. `spawn` resolves a name against the
 *  child's PATH, and that PATH is VS Code's startup snapshot unless the caller
 *  refreshed it, so `'node'` was a hidden fallback (CLAUDE.md: no fallbacks
 *  unless requested) that reported `spawn node ENOENT` — a stream error — where
 *  the truth is "Node is not installed". Nothing here picks a substitute
 *  program silently: the vendored `codex.exe` inside the npm package is the
 *  *user's* fix, named in the refusal, not Forge's choice.
 *
 *  `path.join` (not `path.win32.join`) is deliberate: this module is called on
 *  Windows in production, and its unit tests run on the ubuntu and macOS CI
 *  runners too, where a backslash-joined path would not be the file the test
 *  just created. `toPathSeparators` above already normalises the shim's own
 *  `\` separators for that reason. */
export function resolveShimNodeExecutable(
  shimDir: string,
  cliLabel: string,
  pathValue: string,
  deps: ShimNodeLookupDeps = {},
): string {
  const exists = deps.exists ?? fs.existsSync;
  const bundledNode = path.join(shimDir, 'node.exe');
  if (exists(bundledNode)) return bundledNode;
  const launcher = (deps.which ?? defaultWhichOnPath)('node.exe', pathValue);
  if (launcher) return launcher;
  throw new CliAgentError(
    `Node.js not found, needed to run ${cliLabel}. Install Node ` +
      "(winget install OpenJS.NodeJS.LTS), or set `cli` to the CLI's own executable.",
  );
}

/** `where.exe <program>` searching `pathValue`, through the repo's one
 *  synchronous probe (`systemProbe` in `src/tools/execProgramResolver.ts`) so
 *  this file does not grow its own copy of it. `where` follows the PATH in the
 *  environment block it is given — verified against the real program
 *  2026-10-26: a stripped PATH exits 1 with `INFO: Could not find files for the
 *  given pattern(s).` — so a refreshed PATH can be searched without mutating
 *  `process.env`, which would change the whole extension host. */
function defaultWhichOnPath(program: string, pathValue: string): string | undefined {
  return systemProbe().which(program, pathValue)[0];
}

/** Seam for reading a shim and locating the program it needs, so a unit test
 *  never touches disk, `where.exe` or the registry. */
export interface ShimUnwrapDeps extends ShimNodeLookupDeps {
  /** PATH searched for `node.exe` when none sits beside the shim — normally the
   *  refreshed Windows PATH, so the launcher resolves the way a freshly opened
   *  terminal resolves it. Defaults to the inherited PATH, which is the one the
   *  child would have been given anyway. */
  nodePath?: string;
  /** Name the Node-missing refusal should blame: the `cli` config value, or the
   *  shim's own basename when nothing names it. */
  cliLabel?: string;
}

/** Reads an npm cmd-shim and returns what it would launch, so the target can
 *  be spawned directly with no cmd.exe in between. Through cmd.exe a line
 *  break ends the command: every multi-line `codex queue --message` arrived
 *  as its first line only. `undefined` when the file is not an npm shim or
 *  its target is missing; the caller then takes the escaped cmd.exe path.
 *  A node-script shim whose launcher cannot be found *throws* instead: that is
 *  not a "not an npm shim" answer, and running the same file through cmd.exe
 *  would only repeat the failure with worse diagnostics. */
export function unwrapNpmCmdShim(
  shimPath: string,
  deps: ShimUnwrapDeps = {},
): { file: string; args: string[] } | undefined {
  const exists = deps.exists ?? fs.existsSync;
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
    const target = path.join(dir, toPathSeparators(script));
    if (!exists(target)) return undefined;
    return {
      file: resolveShimNodeExecutable(
        dir,
        deps.cliLabel ?? path.win32.basename(shimPath),
        deps.nodePath ?? process.env['PATH'] ?? '',
        { exists, ...(deps.which ? { which: deps.which } : {}) },
      ),
      args: [target],
    };
  }
  const exe = NPM_NATIVE_EXE_LINE.exec(lastLine)?.[1];
  if (exe !== undefined) {
    const target = path.join(dir, toPathSeparators(exe));
    return exists(target) ? { file: target, args: [] } : undefined;
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
 * spaced executable path (`C:\Users\jo smith\npm\codex.cmd`) is held
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
