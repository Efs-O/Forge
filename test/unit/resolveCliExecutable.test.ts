import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { pickExecutable, resolveCliExecutable } from '../../src/agents/resolveCliExecutable';

// Paths must be absolute on the *running* platform: production uses the
// platform's path.isAbsolute, so a hardcoded `C:\...` is not absolute on POSIX
// CI runners. path.resolve yields a platform-correct absolute path.
const absClaude = path.resolve(path.sep, 'tools', 'claude.exe');
const absMissing = path.resolve(path.sep, 'tools', 'missing.exe');

// reg.exe's own output shape, as captured 2026-10-26. `windowsUserPath.test.ts`
// owns the full real-shape fixtures and the parsing tests; these are the two
// keys the lookup is handed, kept short so the assertion below is about the
// PATH the lookup receives.
const MACHINE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const USER_KEY = 'HKCU\\Environment';
function regPath(key: string, value: string): string {
  const header = key.startsWith('HKLM')
    ? 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
    : 'HKEY_CURRENT_USER\\Environment';
  return `${header}\r\n    Path    REG_EXPAND_SZ    ${value}\r\n\r\n`;
}

describe('resolveCliExecutable', () => {
  it('returns an absolute path unchanged when it exists on disk', async () => {
    const exists = vi.fn(() => true);
    const result = await resolveCliExecutable(absClaude, 'claude', { exists });
    expect(result).toBe(absClaude);
    expect(exists).toHaveBeenCalledWith(absClaude);
  });

  it('throws a clear error for a configured absolute path that does not exist', async () => {
    const exists = vi.fn(() => false);
    await expect(resolveCliExecutable(absMissing, 'codex', { exists })).rejects.toThrow(
      `codex CLI not found at configured path "${absMissing}" — install it and log in.`,
    );
  });

  it('resolves a bare name via the PATH lookup dependency', async () => {
    const which = vi.fn(
      async (_name: string, _env?: NodeJS.ProcessEnv) => `/usr/local/bin/${_name}`,
    );
    const result = await resolveCliExecutable('claude', 'claude', { which, platform: 'linux' });
    expect(result).toBe('/usr/local/bin/claude');
    // No refresh was read, so the lookup inherits the process environment —
    // exactly what it did before, and what it still does on POSIX.
    expect(which).toHaveBeenCalledWith('claude', undefined);
  });

  it('throws the install-and-log-in error when PATH lookup fails', async () => {
    const which = vi.fn(async () => {
      throw new Error('not found');
    });
    await expect(
      resolveCliExecutable('codex', 'codex', { which, platform: 'linux' }),
    ).rejects.toThrow(
      'codex CLI not found on PATH — install it and log in. If you installed it after ' +
        'opening VS Code, quit VS Code completely and reopen it (a window reload does ' +
        'not refresh PATH).',
    );
  });

  it('hands the lookup the PATH the registry holds right now, on Windows', async () => {
    let searched: NodeJS.ProcessEnv | undefined;
    const which = vi.fn(async (_name: string, env?: NodeJS.ProcessEnv) => {
      searched = env;
      return 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd';
    });
    const execFile = vi.fn((_file: string, args: readonly string[]) =>
      args[1] === MACHINE_KEY
        ? regPath(MACHINE_KEY, '%SystemRoot%;C:\\Program Files\\nodejs\\')
        : regPath(USER_KEY, '%USERPROFILE%\\AppData\\Roaming\\npm'),
    );
    const env = {
      PATH: 'C:\\Existing\\tools',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\me',
    };
    await resolveCliExecutable('codex', 'codex', {
      which,
      execFile,
      platform: 'win32',
      env,
    });
    // `where` follows the PATH in the environment block it is given, so this is
    // the whole of issue 3: the npm bin and the Node folder are visible to the
    // lookup even though VS Code started without them.
    expect(searched?.PATH).toBe(
      'C:\\Windows;C:\\Program Files\\nodejs\\;C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Existing\\tools',
    );
    expect(searched?.SystemRoot).toBe('C:\\Windows');
  });

  it('keeps the inherited PATH when the registry cannot answer', async () => {
    let searched: NodeJS.ProcessEnv | undefined = { PATH: 'preset' };
    const which = vi.fn(async (_name: string, env?: NodeJS.ProcessEnv) => {
      searched = env;
      return '/usr/bin/codex';
    });
    await resolveCliExecutable('codex', 'codex', {
      which,
      execFile: () => undefined,
      platform: 'win32',
      env: { PATH: 'C:\\Existing\\tools' },
    });
    // Nothing is guessed: no refreshed PATH, no environment block, and `where`
    // inherits the process environment as it always did.
    expect(searched).toBeUndefined();
  });

  it('never reads the registry for an absolute configured path', async () => {
    const exists = vi.fn(() => true);
    const execFile = vi.fn(() => undefined);
    await resolveCliExecutable(absClaude, 'claude', { exists, execFile, platform: 'win32' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('hands `where` one path key, not the stale `Path` beside the fresh `PATH`', async () => {
    let searched: NodeJS.ProcessEnv | undefined;
    const which = vi.fn(async (_name: string, env?: NodeJS.ProcessEnv) => {
      searched = env;
      return 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd';
    });
    const execFile = vi.fn((_file: string, args: readonly string[]) =>
      args[1] === MACHINE_KEY
        ? regPath(MACHINE_KEY, '%SystemRoot%;C:\\Program Files\\nodejs\\')
        : regPath(USER_KEY, '%USERPROFILE%\\AppData\\Roaming\\npm'),
    );
    // The environment a Windows extension host really has: the name stored as
    // `Path`, not `PATH`. Spreading it and adding `PATH` would have handed
    // `where` two path keys with two different values.
    await resolveCliExecutable('codex', 'codex', {
      which,
      execFile,
      platform: 'win32',
      env: {
        Path: 'C:\\Existing\\tools',
        SystemRoot: 'C:\\Windows',
        USERPROFILE: 'C:\\Users\\me',
      },
    });
    expect(Object.keys(searched ?? {}).filter((key) => key.toLowerCase() === 'path')).toEqual([
      'PATH',
    ]);
    expect(searched?.['PATH']).toContain('C:\\Program Files\\nodejs\\');
    expect(searched?.SystemRoot).toBe('C:\\Windows');
  });

  it('does not tell the user to quit VS Code when the fresh PATH was already searched', async () => {
    const which = vi.fn(async () => {
      throw new Error('where.exe exited with 1');
    });
    const execFile = vi.fn((_file: string, args: readonly string[]) =>
      args[1] === MACHINE_KEY
        ? regPath(MACHINE_KEY, '%SystemRoot%;C:\\Program Files\\nodejs\\')
        : regPath(USER_KEY, '%USERPROFILE%\\AppData\\Roaming\\npm'),
    );
    const message = await resolveCliExecutable('codex', 'codex', {
      which,
      execFile,
      platform: 'win32',
      env: { PATH: 'C:\\Existing\\tools', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' },
    }).catch((error) => (error as Error).message);
    // The PATH the registry holds right now was searched and the CLI is still
    // not on it, so quitting VS Code would change nothing: the advice has to
    // match what was actually searched or it is a lie.
    expect(message).toContain('codex CLI not found on PATH — install it and log in.');
    expect(message).not.toContain('quit VS Code');
  });

  it('keeps the quit-VS-Code advice when no fresh PATH was searched', async () => {
    const which = vi.fn(async () => {
      throw new Error('where.exe exited with 1');
    });
    // The registry cannot answer, so the lookup fell back to the inherited
    // PATH — VS Code's startup snapshot — and only then failed.
    const message = await resolveCliExecutable('codex', 'codex', {
      which,
      execFile: () => undefined,
      platform: 'win32',
      env: { PATH: 'C:\\Existing\\tools' },
    }).catch((error) => (error as Error).message);
    expect(message).toContain('codex CLI not found on PATH — install it and log in.');
    expect(message).toContain('quit VS Code completely and reopen it');
  });

  it('prefers the .cmd shim on Windows when where lists the extensionless shim first', () => {
    const matches = [
      'C:\\Users\\me\\AppData\\Roaming\\npm\\codex',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd',
    ];
    expect(pickExecutable(matches, 'win32')).toBe(matches[1]);
  });

  it('keeps the first match on Windows when no .cmd/.bat shim is present', () => {
    const matches = ['C:\\Program Files\\codex\\codex.exe'];
    expect(pickExecutable(matches, 'win32')).toBe(matches[0]);
  });

  it('keeps the first match on POSIX regardless of extension', () => {
    const matches = ['/usr/local/bin/codex', '/usr/local/bin/codex.cmd'];
    expect(pickExecutable(matches, 'linux')).toBe(matches[0]);
  });

  /**
   * `docs/reports/V1_SECURITY_LIVE_TEST.md` re-run, finding 4: this was the only
   * spawn in Forge that did not pass `windowsHide`, so `where` opened a console
   * window on the owner's desktop every time Forge resolved a CLI from PATH.
   * resolved a CLI. The fake below returns what the real `where`/`which` returns
   * — matches on stdout, one per line — so what is proved is the call Forge
   * actually makes, not a shape this file invented. These tests do not inject
   * `which`, so they go through the finder Forge runs in production.
   */
  it('hides the console window when it runs the finder itself', async () => {
    const calls: Array<{
      file: string;
      args: readonly string[];
      options?: { env?: NodeJS.ProcessEnv; windowsHide?: boolean };
    }> = [];
    const finderExecFile = vi.fn(
      async (
        file: string,
        args: readonly string[],
        options?: { env?: NodeJS.ProcessEnv; windowsHide?: boolean },
      ) => {
        calls.push({ file, args, options });
        return { stdout: '/usr/local/bin/claude\r\n' };
      },
    );
    const result = await resolveCliExecutable('claude', 'claude', {
      platform: 'win32',
      // The registry cannot answer here, so the lookup inherits the process
      // environment — and still hides the window, which is the whole fix.
      execFile: () => undefined,
      finderExecFile,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['claude']);
    // `where` on Windows, `which` elsewhere, chosen from the real
    // `process.platform` so the finder matches the machine it runs on: CI
    // runners are POSIX, so this asserts the name is one of the two.
    expect(['where', 'which']).toContain(calls[0]?.file);
    expect(calls[0]?.options).toMatchObject({ windowsHide: true });
    // One match, so the choice is the same on every OS: the point of this test
    // is the options, not which shim wins.
    expect(result).toBe('/usr/local/bin/claude');
  });

  it('hands the PATH the registry holds right now to the finder it runs itself', async () => {
    let searched: NodeJS.ProcessEnv | undefined;
    const finderExecFile = vi.fn(
      async (
        _file: string,
        _args: readonly string[],
        options?: { env?: NodeJS.ProcessEnv; windowsHide?: boolean },
      ) => {
        searched = options?.env;
        return { stdout: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd\r\n' };
      },
    );
    const execFile = vi.fn((_file: string, args: readonly string[]) =>
      args[1] === MACHINE_KEY
        ? regPath(MACHINE_KEY, '%SystemRoot%;C:\\Program Files\\nodejs\\')
        : regPath(USER_KEY, '%USERPROFILE%\\AppData\\Roaming\\npm'),
    );
    await resolveCliExecutable('claude', 'claude', {
      platform: 'win32',
      execFile,
      env: { PATH: 'C:\\Existing\\tools', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' },
      finderExecFile,
    });
    // The refreshed PATH reaching an injected `which` was the old test; this is
    // the PATH reaching the `where` that Forge really runs, which is what makes
    // a CLI installed after VS Code started findable without quitting VS Code.
    expect(searched?.PATH).toContain('C:\\Users\\me\\AppData\\Roaming\\npm');
    expect(searched?.SystemRoot).toBe('C:\\Windows');
  });

  it('reads the finder output as one path per line, blank lines dropped', async () => {
    const finderExecFile = vi.fn(async () => ({ stdout: '  /usr/local/bin/claude  \r\n\r\n' }));
    await expect(
      resolveCliExecutable('claude', 'claude', { platform: 'linux', finderExecFile }),
    ).resolves.toBe('/usr/local/bin/claude');
  });

  it('says install-and-log-in when the finder it runs itself finds nothing', async () => {
    const finderExecFile = vi.fn(async () => ({ stdout: '' }));
    const message = await resolveCliExecutable('codex', 'codex', {
      platform: 'linux',
      finderExecFile,
    }).catch((error) => (error as Error).message);
    expect(message).toContain('codex CLI not found on PATH — install it and log in.');
  });
});
