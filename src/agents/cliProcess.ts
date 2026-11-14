import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import {
  refreshWindowsPath,
  withWindowsPath,
  type WindowsPathRefresh,
  type WindowsPathSource,
  type WindowsUserPathDeps,
} from './windowsUserPath';
import {
  buildWindowsCmdShellInvocation,
  needsWindowsCmdShellWrap,
  unwrapNpmCmdShim,
} from './windowsCmdShim';
import { protectProcessTree, sweepProtectedTree } from '../util/windowsJobKeeper';

export interface SpawnCliProcessOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  stdin?: 'ignore' | 'pipe';
  /** Variables layered over the inherited environment. */
  env?: Readonly<Record<string, string>>;
  /** Names the CLI in the one-line start log. Defaults to the executable's
   *  basename without its extension — derived from the path, not guessed. */
  cliName?: string;
}

export interface CliProcessExit {
  code: number | null;
  error?: Error;
}

export interface CliProcessInvocation {
  file: string;
  args: string[];
  windowsCmdWrapped: boolean;
  /** Which PATH the child resolves names against: `fresh` is the machine+user
   *  PATH the registry holds right now (what a newly opened terminal gets),
   *  `startup` is the snapshot VS Code started with. Travels with the
   *  invocation so the node lookup, the child environment and the start log
   *  line can never describe three different PATHs. */
  pathSource: WindowsPathSource;
  /** The refreshed PATH, present only when `pathSource === 'fresh'`.
   *  Never logged: environment values are where the user's tokens sit. */
  refreshedPath?: string;
}

/** Seams for {@link buildCliProcessInvocation}, so a unit test never reads the
 *  registry, spawns `where.exe` or depends on the machine's real PATH. */
export interface CliInvocationDeps {
  /** `reg` reader for the Windows PATH refresh. */
  execFile?: WindowsUserPathDeps['execFile'];
  /** Filesystem probe for the shim's target and the `node.exe` beside it. */
  exists?: (candidate: string) => boolean;
  /** PATH search for `node.exe`. */
  which?: (program: string, pathValue: string) => string | undefined;
  /** Environment the refreshed PATH is merged against and the child is spawned
   *  from. Defaults to `process.env`; a test that sets it must pass the same
   *  value to {@link buildCliSpawnEnvironment}, or the two disagree.
   *  Production callers never set it. */
  env?: NodeJS.ProcessEnv;
}

/** The name to put in a message about this executable: the caller's `cliName`
 *  when it has one, otherwise the basename without the extension the user typed
 *  and will install. `path.win32.basename` so a `C:\…` path still splits on
 *  Linux and macOS (CLAUDE.md's `path.basename` trap). */
export function cliLabelFromExecutable(executable: string, cliName?: string): string {
  return cliName ?? path.win32.basename(executable).replace(/\.(cmd|bat|exe|ps1|js)$/i, '');
}

const inheritedSessionVariables = [
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
  'COPILOT_AGENT_SESSION_ID',
] as const;

/** The one child environment builder; agent identity never crosses Forge's boundary.
 *
 *  `refreshedWindowsPath` is what `windowsUserPath.ts` read from the registry at
 *  this spawn. An override that names PATH itself keeps its value — an explicit
 *  setting beats a refreshed one — otherwise the child, and every subprocess the
 *  CLI starts, resolves names the way a freshly opened terminal would instead of
 *  the way VS Code did when it started. */
export function buildCliSpawnEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
  overrides: Readonly<Record<string, string>> = {},
  refreshedWindowsPath?: string,
): NodeJS.ProcessEnv {
  const environment = { ...inherited, ...overrides };
  for (const name of inheritedSessionVariables) delete environment[name];
  const overrideNamesPath = Object.keys(overrides).some((key) => key.toLowerCase() === 'path');
  // `withWindowsPath` drops whatever casing the inherited block happened to use,
  // so the child gets one PATH, not two that Windows would have to choose
  // between — the same rule `where`'s environment block and the probe's own
  // block follow, so the three can never disagree.
  if (refreshedWindowsPath && !overrideNamesPath) {
    return withWindowsPath(environment, refreshedWindowsPath);
  }
  return environment;
}

/** Builds the exact argv used by {@link spawnCliProcess}: an npm `.cmd` shim's
 *  target directly when it can be read, otherwise an escaped cmd.exe line.
 *  On Windows it also resolves the PATH the child will be given, because an npm
 *  node-script shim needs an absolute `node.exe` rather than a name to be
 *  resolved later (`resolveShimNodeExecutable` in `windowsCmdShim.ts`). */
export function buildCliProcessInvocation(
  options: SpawnCliProcessOptions,
  platform: NodeJS.Platform = process.platform,
  deps: CliInvocationDeps = {},
): CliProcessInvocation {
  const baseEnv = deps.env ?? process.env;
  // Explicit win32 gate, as in the argv branch below: nothing on POSIX pays for
  // a registry read, and nothing on POSIX needs one.
  const refresh: WindowsPathRefresh =
    platform === 'win32'
      ? refreshWindowsPath(baseEnv, deps.execFile ? { execFile: deps.execFile } : {})
      : { source: 'startup' };
  const pathFields: Pick<CliProcessInvocation, 'pathSource' | 'refreshedPath'> =
    refresh.path !== undefined
      ? { pathSource: 'fresh', refreshedPath: refresh.path }
      : { pathSource: 'startup' };
  if (platform !== 'win32' || !needsWindowsCmdShellWrap(options.executable)) {
    return {
      file: options.executable,
      args: [...options.args],
      windowsCmdWrapped: false,
      ...pathFields,
    };
  }
  const direct = unwrapNpmCmdShim(options.executable, {
    ...(deps.exists ? { exists: deps.exists } : {}),
    ...(deps.which ? { which: deps.which } : {}),
    // Search the PATH the child is actually about to get: the refreshed one when
    // the registry answered, otherwise the inherited one, which is what
    // buildCliSpawnEnvironment keeps.
    nodePath: refresh.path ?? baseEnv['PATH'] ?? baseEnv['Path'] ?? '',
    cliLabel: cliLabelFromExecutable(options.executable, options.cliName),
  });
  if (direct) {
    return {
      file: direct.file,
      args: [...direct.args, ...options.args],
      windowsCmdWrapped: false,
      ...pathFields,
    };
  }
  return {
    ...buildWindowsCmdShellInvocation(options.executable, [...options.args]),
    windowsCmdWrapped: true,
    ...pathFields,
  };
}

/** Any argv token that looks like a credential is replaced rather than dropped,
 *  so the start line still shows the shape of the call. These are the shapes the
 *  CLIs actually carry: `--api-key`, `--anthropic-key`, `…token…`, `sk-…`. */
const SECRET_ARGV_TOKEN = /token|key|secret|^sk-/i;
const REDACTED_ARGV_TOKEN = '<redacted>';
/** A token that begins with `-` is another flag, not the value of the one before
 *  it, so it is never a secret to redact. */
const IS_FLAG = /^-/u;

/** Redacts every credential value in `argv` in both forms the CLIs use. A token
 *  that names a secret carries its own value when it is `--token=X` or `sk-X`,
 *  and puts it in the NEXT token when it is `--api-key X` — the second form was
 *  the half the old per-token rule missed, and `abc123` went into the log line
 *  and into `.forge/sessions/*.jsonl` in clear. A flag that does not name a
 *  secret keeps its value: `--model gpt` still shows `gpt`, which is what makes
 *  the line worth reading. */
function redactArgvTokens(argv: readonly string[]): string[] {
  const out = argv.map((arg) => (SECRET_ARGV_TOKEN.test(arg) ? REDACTED_ARGV_TOKEN : arg));
  for (let i = 0; i + 1 < out.length; i++) {
    if (IS_FLAG.test(argv[i]) && SECRET_ARGV_TOKEN.test(argv[i]) && !IS_FLAG.test(argv[i + 1])) {
      out[i + 1] = REDACTED_ARGV_TOKEN;
    }
  }
  return out;
}

/** The Forge output channel is loaded lazily, on purpose. `src/util/logger`
 *  creates that channel the moment it is imported, and `cliProcess.ts` is pulled
 *  in by modules that only want `terminateProcessTree` (`src/util/processSpawn.ts`,
 *  `src/tools/shellTool.ts`) and by tests that mock `vscode` minimally — an
 *  eager import here would make importing this module require VS Code. The line
 *  lands one microtask after the spawn; every later CLI line comes from a
 *  process event, a whole turn later, so the start line still precedes them.
 *  A logging failure must never fail a spawn, and never goes unreported: when
 *  the channel cannot be reached the line goes to `console.error` below, which
 *  needs no vscode and still lands in the host's output. (`no-console` is
 *  disabled for that one line: here the console is the report, not debug
 *  chatter.) */
function logCliStart(line: string): void {
  void import('../util/logger')
    .then(({ getLogger }) => getLogger().info(line))
    .catch((error: unknown) => {
      // eslint-disable-next-line no-console -- The channel was the report; this is its fallback.
      console.error('[cli-agent] start line could not be logged:', error, line);
    });
}

/**
 * Spawns an already-resolved CLI executable. npm-installed CLI `.cmd` shims
 * require an explicit cmd.exe invocation on Windows; real executables are
 * spawned directly.
 *
 * Every CLI cold start writes exactly one line to the Forge output channel.
 * This is the only place that knows the argv, the cwd and which PATH the child
 * was given, and the Windows report that started this work was written from red
 * text alone because nothing said any of it. Only argv is printed, never an
 * environment value: the child env is where the user's tokens sit
 * (`CLAUDE_SPAWN_ENV`, an adapter's `spawnEnv`) and CLAUDE.md's Hard Stops put
 * keys in SecretStorage, so an `env=…` dump would leak them into the channel and
 * into `.forge/sessions/*.jsonl`.
 */
export function spawnCliProcess(
  options: SpawnCliProcessOptions,
  invocation: CliProcessInvocation = buildCliProcessInvocation(options),
): ChildProcess {
  const environment = buildCliSpawnEnvironment(process.env, options.env, invocation.refreshedPath);
  logCliStart(
    `[cli-agent] start ${cliLabelFromExecutable(options.executable, options.cliName)}` +
      ` file=${invocation.file}` +
      ` wrapped=${invocation.windowsCmdWrapped}` +
      ` args=${JSON.stringify(redactArgvTokens(invocation.args))}` +
      ` cwd=${options.cwd}` +
      ` pathSource=${invocation.pathSource}`,
  );
  const proc = spawn(invocation.file, invocation.args, {
    cwd: options.cwd,
    env: environment,
    stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // POSIX: make the child a process-group leader so terminateProcessTree can
    // signal the whole tree with process.kill(-pid). Without this, a CLI agent
    // that forks its own subprocesses leaves them running after the direct
    // child is killed. Windows kills via a taskkill /T job instead, so detached
    // is irrelevant there.
    ...(process.platform !== 'win32' ? { detached: true } : {}),
    ...(invocation.windowsCmdWrapped ? { windowsVerbatimArguments: true } : {}),
  });
  // A CLI agent forks its own subprocesses, and on Windows those escape a
  // `taskkill /T` when their creator exits (see windowsJobKeeper.ts).
  protectProcessTree(proc);
  return proc;
}

/** Resolves on the first process exit or spawn error. */
export function waitForCliProcessExit(proc: ChildProcess): Promise<CliProcessExit> {
  return new Promise<CliProcessExit>((resolve) => {
    proc.once('exit', (code) => resolve({ code }));
    proc.once('error', (error) => resolve({ code: null, error }));
  });
}

/** What `signalWindowsTree` asks for, so a test can watch the order on any OS. */
export interface WindowsTreeDeps {
  spawnTaskkill?: (pid: number) => ChildProcess;
  sweepJob?: (pid: number | undefined) => boolean;
  settle?: (done: () => void, ms: number) => void;
}

/**
 * Kill one Windows process tree: the job sweep, then `taskkill /T /F`.
 *
 * The sweep goes out first on purpose. The keeper reads a single pipe in order,
 * and the child's own `exit` event asks for a `release` — the "it finished on
 * its own" path. `kill` ahead of that means the keeper sees kill-then-release
 * and the survivors die; a release that lands first would leave them running.
 *
 * `taskkill /T` still runs, for the trees this module never protected: a
 * command started before the keeper was up, or a job whose assignment failed.
 * It walks the tree from the live parent, so the parent must not die first —
 * killing it with `proc.kill()` beforehand left every grandchild running (a
 * timed-out `sleep 20` under bash, a CLI agent's own subprocesses). The parent's
 * exit is not the signal either: the tree is gone only when taskkill returns.
 */
export function signalWindowsTree(
  proc: ChildProcess,
  onDone: () => void,
  deps: WindowsTreeDeps = {},
): void {
  const sweep = deps.sweepJob ?? sweepProtectedTree;
  const spawnTaskkill =
    deps.spawnTaskkill ??
    ((pid: number): ChildProcess =>
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      }));
  const settle = deps.settle ?? ((done: () => void, ms: number): void => void setTimeout(done, ms));
  sweep(proc.pid);
  const pid = proc.pid;
  if (pid === undefined) {
    settle(onDone, 0);
    return;
  }
  const killer = spawnTaskkill(pid);
  const fallback = (): void => {
    try {
      proc.kill();
    } catch {
      // Already gone; taskkill's failure was "process not found".
    }
    settle(onDone, 250);
  };
  killer.once('exit', (code) => (code === 0 ? settle(onDone, 250) : fallback()));
  killer.once('error', fallback);
}

/**
 * Terminates a Forge-owned CLI process tree. Windows sweeps the job object (see
 * `windowsJobKeeper.ts`) and runs `taskkill /T /F`, resolving when it returns;
 * POSIX sends SIGTERM then SIGKILL after a grace period. Cleanup never waits
 * longer than six seconds.
 */
export function terminateProcessTree(proc: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    if (process.platform === 'win32' && proc.pid) {
      signalWindowsTree(proc, finish);
    } else {
      proc.once('exit', finish);
      proc.once('error', finish);
      // POSIX: signal the whole process group, not just the direct child. The
      // child is a group leader (spawned detached), so -pid reaches every
      // descendant it forked. If it is not a group leader (e.g. a child from
      // spawnAndWait, which does not detach), -pid matches no group and we fall
      // back to signalling the direct child, preserving the old behaviour.
      const pid = proc.pid;
      const signalTree = (sig: NodeJS.Signals): boolean => {
        if (pid !== undefined) {
          try {
            process.kill(-pid, sig);
            return true;
          } catch {
            // Not a group leader, or the group is already gone — fall through.
          }
        }
        try {
          proc.kill(sig);
          return true;
        } catch {
          // The process (and its group) already exited.
          return false;
        }
      };
      if (!signalTree('SIGTERM')) {
        finish();
        return;
      }
      setTimeout(() => signalTree('SIGKILL'), 5000);
    }
    setTimeout(finish, 6000);
  });
}

/** Backward-compatible name for CLI adapters. */
export const terminateCliProcessTree = terminateProcessTree;
