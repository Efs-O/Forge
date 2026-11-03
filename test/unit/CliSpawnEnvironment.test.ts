import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCliSpawnEnvironment,
  spawnCliProcess,
  waitForCliProcessExit,
  type CliProcessInvocation,
} from '../../src/agents/cliProcess';

// The start log line is what issue 4 of the Windows report asked for, so the
// output channel is faked here instead of asserted through vscode. `throwNext`
// stands in for a channel that cannot be reached, which is the case the
// `console.error` fallback exists for.
const logged = vi.hoisted(() => ({ lines: [] as string[], throwNext: false }));
vi.mock('../../src/util/logger', () => ({
  getLogger: () => ({
    info: (line: string) => {
      if (logged.throwNext) {
        logged.throwNext = false;
        throw new Error('output channel gone');
      }
      logged.lines.push(line);
    },
    warn: (line: string) => logged.lines.push(line),
    error: (line: string) => logged.lines.push(line),
  }),
}));

/** A cold start that really spawns, with the registry, `where.exe` and the
 *  output channel all faked: the launcher is `process.execPath`, so the only
 *  real process is the Node already running this test. */
function start(
  options: {
    executable: string;
    args: readonly string[];
    cwd: string;
    cliName?: string;
    env?: Readonly<Record<string, string>>;
  },
  invocation: Pick<CliProcessInvocation, 'pathSource'> & Partial<CliProcessInvocation>,
): Promise<string> {
  const child = spawnCliProcess(options, {
    file: options.executable,
    args: [...options.args],
    windowsCmdWrapped: false,
    ...invocation,
  });
  return waitForCliProcessExit(child).then(() => {
    const line = logged.lines[logged.lines.length - 1] ?? '';
    if (!line) throw new Error('no start line was logged');
    return line;
  });
}

describe('agent child environment', () => {
  it('strips session identity variables from inherited and adapter-provided values', () => {
    const environment = buildCliSpawnEnvironment(
      {
        PATH: 'path-value',
        CLAUDE_CODE_SESSION_ID: 'parent-claude',
        CODEX_SESSION_ID: 'parent-codex',
        COPILOT_AGENT_SESSION_ID: 'parent-copilot',
      },
      {
        CLAUDE_CODE_SESSION_ID: 'override-claude',
        CODEX_SESSION_ID: 'override-codex',
        COPILOT_AGENT_SESSION_ID: 'override-copilot',
        KEEP_ME: 'yes',
      },
    );
    expect(environment).toEqual({ PATH: 'path-value', KEEP_ME: 'yes' });
  });

  it('gives the child the refreshed PATH when one was read', () => {
    const environment = buildCliSpawnEnvironment(
      { PATH: 'C:\\Windows;C:\\Program Files\\nodejs', CLAUDE_CODE_SESSION_ID: 'parent' },
      { KEEP_ME: 'yes' },
      'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd;C:\\Users\\me\\AppData\\Roaming\\npm',
    );
    expect(environment.PATH).toBe(
      'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd;C:\\Users\\me\\AppData\\Roaming\\npm',
    );
    expect(environment.KEEP_ME).toBe('yes');
    expect(environment.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });

  it('leaves exactly one PATH, whatever case the inherited block used', () => {
    const environment = buildCliSpawnEnvironment({ Path: 'C:\\Startup' }, {}, 'C:\\Fresh');
    expect(Object.keys(environment).filter((key) => key.toLowerCase() === 'path')).toEqual([
      'PATH',
    ]);
    expect(environment.PATH).toBe('C:\\Fresh');
  });

  it('lets an override that names PATH itself keep its value', () => {
    const environment = buildCliSpawnEnvironment(
      { PATH: 'C:\\Startup' },
      { PATH: 'C:\\Adapter\\bin' },
      'C:\\Fresh',
    );
    expect(environment.PATH).toBe('C:\\Adapter\\bin');
  });

  it('leaves the startup PATH alone when no refresh was read', () => {
    const environment = buildCliSpawnEnvironment({ PATH: 'C:\\Startup' }, {}, undefined);
    expect(environment.PATH).toBe('C:\\Startup');
  });
});

describe('the one start log line', () => {
  beforeEach(() => {
    logged.lines.length = 0;
  });

  it('names the cli, the file, the argv, the cwd and where the PATH came from', async () => {
    const line = await start(
      { executable: process.execPath, args: ['-p', '1+1'], cwd: os.tmpdir(), cliName: 'codex' },
      {
        pathSource: 'fresh',
        refreshedPath: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
      },
    );
    expect(line).toBe(
      `[cli-agent] start codex file=${process.execPath} wrapped=false ` +
        `args=["-p","1+1"] cwd=${os.tmpdir()} pathSource=fresh`,
    );
  });

  it('redacts an argv token that looks like a credential instead of dropping it', async () => {
    const line = await start(
      {
        executable: process.execPath,
        args: ['--api-key', 'sk-abc123def', 'app-server'],
        cwd: os.tmpdir(),
      },
      { pathSource: 'startup' },
    );
    expect(line).toContain('args=["<redacted>","<redacted>","app-server"]');
    expect(line).not.toContain('sk-abc123def');
    expect(line).toContain('pathSource=startup');
    // No `cliName` was given, so the name comes from the executable's basename
    // with the extension the user typed stripped — derived, not guessed.
    expect(line).toContain(
      `[cli-agent] start ${path.win32.basename(process.execPath).replace(/\.exe$/i, '')} `,
    );
  });

  it('prints no environment value, not even a token the adapter layered in', async () => {
    const line = await start(
      {
        executable: process.execPath,
        args: ['-p', '1+1'],
        cwd: os.tmpdir(),
        env: { ANTHROPIC_API_KEY: 'sk-supersecret-value' },
      },
      { pathSource: 'fresh', refreshedPath: 'C:\\Windows\\System32' },
    );
    expect(line).not.toContain('supersecret');
    expect(line).not.toContain('ANTHROPIC');
    expect(line).toContain('pathSource=fresh');
  });

  it('wraps a cmd.exe line the same way and says so', async () => {
    const line = await start(
      { executable: 'C:\\npm\\codex.cmd', args: ['queue'], cwd: os.tmpdir(), cliName: 'codex' },
      {
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', '"C:\\npm\\codex.cmd queue"'],
        windowsCmdWrapped: true,
        pathSource: 'startup',
      },
    );
    expect(line).toContain('wrapped=true');
    expect(line).toContain('file=C:\\Windows\\System32\\cmd.exe');
    // JSON quoting, so a spaced or quoted path survives the line intact.
    expect(line).toContain(
      `args=${JSON.stringify(['/d', '/s', '/c', '"C:\\npm\\codex.cmd queue"'])}`,
    );
  });

  it('redacts the value a secret flag puts in the NEXT token, not only the flag', async () => {
    // `--api-key abc123` carries its secret in the token after the flag. The old
    // per-token rule redacted `--api-key` and printed `abc123` in clear into the
    // channel and into `.forge/sessions/*.jsonl`.
    const twoToken = await start(
      {
        executable: process.execPath,
        args: ['--api-key', 'abc123'],
        cwd: os.tmpdir(),
        cliName: 'codex',
      },
      { pathSource: 'startup' },
    );
    expect(twoToken).toContain('args=["<redacted>","<redacted>"]');
    expect(twoToken).not.toContain('abc123');

    const oneToken = await start(
      {
        executable: process.execPath,
        args: ['--token=abc123'],
        cwd: os.tmpdir(),
        cliName: 'codex',
      },
      { pathSource: 'startup' },
    );
    expect(oneToken).toContain('args=["<redacted>"]');
    expect(oneToken).not.toContain('abc123');

    const bareKey = await start(
      {
        executable: process.execPath,
        args: ['sk-abc123', 'app-server'],
        cwd: os.tmpdir(),
        cliName: 'codex',
      },
      { pathSource: 'startup' },
    );
    expect(bareKey).toContain('args=["<redacted>","app-server"]');
    expect(bareKey).not.toContain('sk-abc123');

    // A flag that names no secret keeps its value: that is what makes the line
    // worth reading, and `--model` is the one every CLI chat turn carries.
    const harmless = await start(
      {
        executable: process.execPath,
        args: ['--model', 'gpt', 'app-server'],
        cwd: os.tmpdir(),
        cliName: 'codex',
      },
      { pathSource: 'startup' },
    );
    expect(harmless).toContain('args=["--model","gpt","app-server"]');
  });

  it('reports a start line the channel could not receive', async () => {
    // The channel is the report, so a channel that cannot be reached must not
    // go quiet: `console.error` is the fallback and needs no vscode.
    logged.throwNext = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const child = spawnCliProcess(
        { executable: process.execPath, args: ['-p', '1+1'], cwd: os.tmpdir(), cliName: 'codex' },
        {
          file: process.execPath,
          args: ['-p', '1+1'],
          windowsCmdWrapped: false,
          pathSource: 'startup',
        },
      );
      await waitForCliProcessExit(child);
      // The channel is reached a microtask after the spawn; give the fallback a
      // real tick so the assertion is not a race with the import.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const calls = consoleError.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const reported = (calls[calls.length - 1] ?? []).join(' ');
      expect(reported).toContain('[cli-agent] start codex');
      expect(reported).toContain('pathSource=startup');
      // And the line was not logged twice: the channel never got it.
      expect(logged.lines.some((line) => line.includes('[cli-agent] start codex'))).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });
});
