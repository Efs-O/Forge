import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Single owner of "what does `exec_command` actually spawn". Commands run with
 * `shell: false`, so anything that is not a real executable image has to be
 * translated here or it cannot run at all.
 */

export interface PackageRunnerInvocation {
  command: string;
  argsPrefix: string[];
}

export interface ExecInvocation {
  command: string;
  args: string[];
}

export type PackageRunner = 'npm' | 'npx';

/** Injectable seam so the Windows resolution rules are testable off Windows. */
export interface RunnerProbe {
  /** Every match for a program name on PATH, in PATH order. */
  which(program: string): string[];
  exists(candidate: string): boolean;
}

function whichAll(program: string): string[] {
  const lookup = child_process.spawnSync('where.exe', [program], { encoding: 'utf8' });
  return (lookup.stdout ?? '')
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const SYSTEM_PROBE: RunnerProbe = {
  which: whichAll,
  exists: (candidate) => fs.existsSync(candidate),
};

/**
 * npm and npx are .cmd shims on Windows, which cannot be passed to spawn with
 * shell:false. Resolve the shim to a node.exe and the npm CLI script so project
 * scripts remain shell-free and user arguments cannot become shell syntax.
 *
 * A shim does NOT have to sit beside a node.exe. `npm install -g npm` puts a
 * second shim in the npm prefix directory — on Windows that is %APPDATA%\npm,
 * which carries node_modules/npm but no node.exe — and the prefix usually
 * precedes the Node install on PATH. The real .cmd handles that case itself
 * (`IF EXIST %dp0%\node.exe ... ELSE SET _prog=node`); requiring an adjacent
 * node.exe instead made every `npm run <script>` fail outright with "expected
 * node executable and CLI beside the resolved shim". So: prefer a shim that is
 * self-contained, and otherwise pair its CLI with node resolved from PATH.
 */
export function resolvePackageRunnerInvocation(
  runner: PackageRunner,
  platform: NodeJS.Platform = process.platform,
  probe: RunnerProbe = SYSTEM_PROBE,
): PackageRunnerInvocation {
  if (platform !== 'win32') return { command: runner, argsPrefix: [] };

  const shims = probe
    .which(`${runner}.cmd`)
    .filter((entry) => entry.toLowerCase().endsWith(`${runner}.cmd`));
  if (shims.length === 0) throw new Error(`${runner}: Windows command shim was not found on PATH`);

  const candidates = shims.map((shim) => {
    const installRoot = path.dirname(shim);
    return {
      installRoot,
      node: path.join(installRoot, 'node.exe'),
      cli: path.join(installRoot, 'node_modules', 'npm', 'bin', `${runner}-cli.js`),
    };
  });

  const selfContained = candidates.find((c) => probe.exists(c.node) && probe.exists(c.cli));
  if (selfContained) return { command: selfContained.node, argsPrefix: [selfContained.cli] };

  const withCli = candidates.find((c) => probe.exists(c.cli));
  const node = probe.which('node.exe')[0];
  if (withCli && node) return { command: node, argsPrefix: [withCli.cli] };

  const roots = candidates.map((c) => c.installRoot).join(', ');
  throw new Error(
    withCli
      ? `${runner}: found ${withCli.cli} but no node.exe on PATH to run it with`
      : `${runner}: no ${runner}-cli.js beside any shim on PATH (looked in ${roots})`,
  );
}

/**
 * Recognises the package runners in the two forms a model writes them: bare
 * (`npm`), and with the Windows extension it reaches for after the bare name
 * fails with ENOENT (`npm.cmd`).
 *
 * Deliberately NOT an absolute path to a shim. Canonicalising one would mean
 * re-resolving through PATH and possibly running a different npm than the path
 * named, and it would let a path spelling reach a runner the denylist inspects
 * by bare name.
 */
export function matchPackageRunner(command: string): PackageRunner | undefined {
  const base = command.toLowerCase();
  const stem = base.endsWith('.cmd') ? base.slice(0, -4) : base;
  return stem === 'npm' || stem === 'npx' ? stem : undefined;
}

/**
 * The name the guards must inspect. `npm.cmd` and `npm` are the same program,
 * so the denylist has to see one spelling — `COMMAND_PREFIXES` there knows
 * `npm`, and would wave `npm.cmd rm -rf .` straight through otherwise.
 * Canonicalise BEFORE any guard runs, never after.
 */
export function canonicalizeExecCommand(command: string): string {
  return matchPackageRunner(command) ?? command;
}

/**
 * cmd.exe builtins have no executable image, so `spawn` reports them as a
 * missing program — a confusing message, since the model can see the command
 * work in its own terminal. Name the tool that does the job instead.
 */
const CMD_BUILTIN_ALTERNATIVES: ReadonlyMap<string, string> = new Map([
  ['dir', 'Use the list_directory tool.'],
  ['ls', 'Use the list_directory tool.'],
  ['cd', 'Pass the cwd argument to exec_command instead.'],
  ['copy', 'Use read_file and write_file.'],
  ['move', 'Use read_file, write_file, and delete_file.'],
  ['del', 'Use the delete_file tool.'],
  ['erase', 'Use the delete_file tool.'],
  ['rd', 'Use delete_file with recursive: true.'],
  ['rmdir', 'Use delete_file with recursive: true.'],
  ['md', 'Use the create_directory tool.'],
  ['mkdir', 'Use the create_directory tool.'],
  ['type', 'Use the read_file tool.'],
  ['echo', 'Use write_file to create file content.'],
  ['set', 'Environment variables cannot be set for exec_command.'],
  ['cls', 'There is no terminal to clear.'],
]);

export function describeShellBuiltin(command: string): string | undefined {
  const base = path.basename(command).toLowerCase();
  return CMD_BUILTIN_ALTERNATIVES.get(base);
}

/**
 * Translates a model-supplied command+args into what actually gets spawned.
 * Everything else passes through untouched — this deliberately resolves a
 * known, closed set rather than searching PATHEXT for arbitrary shims, because
 * a general .cmd/.bat launcher would hand back the shell that `shell: false`
 * exists to withhold.
 */
export function resolveExecInvocation(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  probe?: RunnerProbe,
): ExecInvocation {
  const runner = matchPackageRunner(command);
  if (!runner) return { command, args };

  const invocation = resolvePackageRunnerInvocation(runner, platform, probe);
  return { command: invocation.command, args: [...invocation.argsPrefix, ...args] };
}
