import { describe, expect, it, vi } from 'vitest';
import { refreshWindowsPath, withWindowsPath } from '../../src/agents/windowsUserPath';

/**
 * Windows builds a logon PATH from two registry keys, machine then user. These
 * fixtures are reg.exe's own output shape, captured from the real program on
 * 2026-10-26 (`reg query <key> /v Path`): the key header, then four spaces +
 * `Path` + four spaces + the type + four spaces + the value, CRLF-terminated,
 * then blank lines. A fake of an external program returns what the real one
 * returns (CLAUDE.md), so the parser is tested against this and not against
 * what it hopes for.
 */
const MACHINE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const USER_KEY = 'HKCU\\Environment';
const MACHINE_HEADER =
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const USER_HEADER = 'HKEY_CURRENT_USER\\Environment';

function regOutput(header: string, value: string, type = 'REG_EXPAND_SZ'): string {
  return `${header}\r\n    Path    ${type}    ${value}\r\n\r\n\r\n`;
}

/** The machine value as it actually reads on this desktop: `%SystemRoot%` tokens
 *  that must be expanded, and `C:\Program Files\nodejs\` — the entry that makes
 *  an npm shim's `node` launcher resolvable at all. */
const MACHINE_PATH =
  '%SystemRoot%\\system32;%SystemRoot%;%SystemRoot%\\System32\\Wbem;' +
  'C:\\Program Files\\nodejs\\;C:\\Program Files\\Git\\cmd;C:\\Program Files\\PowerShell\\7\\';

/** The user value as it reads on this desktop: `%USERPROFILE%` tokens, the npm
 *  bin where `codex.cmd` lives, and a duplicate of the machine entry in another
 *  case and without its trailing separator. */
const USER_PATH = '%USERPROFILE%\\AppData\\Roaming\\npm;C:\\Tools;C:\\PROGRAM FILES\\NODEJS';

/** VS Code's frozen startup snapshot: a directory nothing else has, plus the
 *  Node folder again (so dedupe has something to do on the inherited side too). */
const STARTUP_ENV: NodeJS.ProcessEnv = {
  PATH: 'C:\\Existing\\tools;C:\\Program Files\\nodejs',
  SystemRoot: 'C:\\Windows',
  USERPROFILE: 'C:\\Users\\me',
  COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
};

/** `reg query <key> /v Path` for the two keys, with `undefined` standing in for
 *  reg.exe's non-zero exit (`ERROR: The system was unable to find the specified
 *  registry key or value.`), which Node turns into a thrown Error. */
function fakeReg(machine: string | undefined, user: string | undefined) {
  const calls: Array<{ file: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const execFile = vi.fn(
    (file: string, args: readonly string[], env: NodeJS.ProcessEnv): string | undefined => {
      calls.push({ file, args, env });
      if (
        file !== 'reg' ||
        args[0] !== 'query' ||
        args[2] !== '/v' ||
        args[3] !== 'Path' ||
        (args[1] !== MACHINE_KEY && args[1] !== USER_KEY)
      ) {
        return undefined;
      }
      return args[1] === MACHINE_KEY ? machine : user;
    },
  );
  return { execFile, calls };
}

describe('refreshWindowsPath', () => {
  it('merges machine, then user, then whatever VS Code already had', () => {
    const { execFile } = fakeReg(
      regOutput(MACHINE_HEADER, MACHINE_PATH),
      regOutput(USER_HEADER, USER_PATH),
    );
    const refresh = refreshWindowsPath(STARTUP_ENV, { execFile });

    expect(refresh.source).toBe('fresh');
    expect(refresh.path).toBe(
      [
        // Machine first, exactly as Windows puts it together at logon.
        'C:\\Windows\\system32',
        'C:\\Windows',
        'C:\\Windows\\System32\\Wbem',
        'C:\\Program Files\\nodejs\\',
        'C:\\Program Files\\Git\\cmd',
        'C:\\Program Files\\PowerShell\\7\\',
        // Then the user, then the snapshot VS Code started with — in order, so
        // an entry the host already had keeps its position.
        'C:\\Users\\me\\AppData\\Roaming\\npm',
        'C:\\Tools',
        'C:\\Existing\\tools',
      ].join(';'),
    );
  });

  it('expands every %VAR% token Windows would have expanded at logon', () => {
    const { execFile } = fakeReg(
      regOutput(MACHINE_HEADER, MACHINE_PATH),
      regOutput(USER_HEADER, USER_PATH),
    );
    const refresh = refreshWindowsPath(STARTUP_ENV, { execFile });
    expect(refresh.path).not.toContain('%');
    expect(refresh.path).toContain('C:\\Windows\\system32');
    expect(refresh.path).toContain('C:\\Users\\me\\AppData\\Roaming\\npm');
  });

  it('dedupes case-insensitively, across a trailing separator', () => {
    const { execFile } = fakeReg(
      regOutput(MACHINE_HEADER, MACHINE_PATH),
      regOutput(USER_HEADER, USER_PATH),
    );
    const refresh = refreshWindowsPath(STARTUP_ENV, { execFile });
    const hits = (refresh.path?.toLowerCase().match(/program files\\nodejs/g) ?? []).length;
    // The machine entry is the one that survives, in its original case and with
    // its trailing separator: the first occurrence is the one Windows would
    // have put first.
    expect(hits).toBe(1);
    expect(refresh.path).toContain('C:\\Program Files\\nodejs\\');
    expect(refresh.path).not.toContain('C:\\PROGRAM FILES\\NODEJS');
  });

  it('keeps an entry it cannot expand instead of guessing it away', () => {
    const { execFile } = fakeReg(
      regOutput(MACHINE_HEADER, '%NOSUCHVAR%\\bin;C:\\Windows'),
      undefined,
    );
    const refresh = refreshWindowsPath(STARTUP_ENV, { execFile });
    // An unexpanded token names a directory that does not exist, which `where`
    // and `spawn` simply skip — dropping it would lose a folder whose name
    // really does contain a `%`.
    expect(refresh.path).toBe(
      '%NOSUCHVAR%\\bin;C:\\Windows;C:\\Existing\\tools;C:\\Program Files\\nodejs',
    );
  });

  it('a missing machine Path keeps the inherited PATH, never a shorter one', () => {
    const { execFile } = fakeReg(undefined, regOutput(USER_HEADER, USER_PATH));
    const refresh = refreshWindowsPath(STARTUP_ENV, { execFile });
    expect(refresh).toEqual({ source: 'startup' });
    expect(refresh.path).toBeUndefined();
  });

  it('a machine key whose value has no Path line is reported as startup', () => {
    const noValue = fakeReg(`${MACHINE_HEADER}\r\n    UserName    REG_SZ    me\r\n\r\n`, undefined);
    expect(refreshWindowsPath(STARTUP_ENV, noValue)).toEqual({ source: 'startup' });
  });

  it('a machine Path of only separators contributes nothing and is not a failure', () => {
    const { execFile } = fakeReg(
      regOutput(MACHINE_HEADER, ';;;'),
      regOutput(USER_HEADER, 'C:\\Tools'),
    );
    const refresh = refreshWindowsPath(STARTUP_ENV, { execFile });
    expect(refresh.path).toBe('C:\\Tools;C:\\Existing\\tools;C:\\Program Files\\nodejs');
  });

  it('a missing user Path value is normal, not a failure', () => {
    const { execFile } = fakeReg(regOutput(MACHINE_HEADER, MACHINE_PATH), undefined);
    const refresh = refreshWindowsPath(STARTUP_ENV, { execFile });
    expect(refresh.source).toBe('fresh');
    expect(refresh.path).toBe(
      [
        'C:\\Windows\\system32',
        'C:\\Windows',
        'C:\\Windows\\System32\\Wbem',
        'C:\\Program Files\\nodejs\\',
        'C:\\Program Files\\Git\\cmd',
        'C:\\Program Files\\PowerShell\\7\\',
        'C:\\Existing\\tools',
      ].join(';'),
    );
  });

  it('accepts a REG_SZ Path, the shape a hand-typed value has', () => {
    const { execFile } = fakeReg(
      regOutput(MACHINE_HEADER, 'C:\\Windows\\system32', 'REG_SZ'),
      regOutput(USER_HEADER, 'C:\\Tools', 'REG_SZ'),
    );
    expect(refreshWindowsPath(STARTUP_ENV, { execFile }).path).toBe(
      'C:\\Windows\\system32;C:\\Tools;C:\\Existing\\tools;C:\\Program Files\\nodejs',
    );
  });

  it('reads the two keys in Windows order, in the environment it was handed', () => {
    const { execFile, calls } = fakeReg(
      regOutput(MACHINE_HEADER, MACHINE_PATH),
      regOutput(USER_HEADER, USER_PATH),
    );
    refreshWindowsPath(STARTUP_ENV, { execFile });
    expect(calls.map((call) => call.args[1])).toEqual([MACHINE_KEY, USER_KEY]);
    expect(calls[0]?.args).toEqual(['query', MACHINE_KEY, '/v', 'Path']);
    expect(calls[0]?.env).toBe(STARTUP_ENV);
  });

  it('finds an inherited PATH stored under a different case', () => {
    const { execFile } = fakeReg(regOutput(MACHINE_HEADER, 'C:\\Windows'), undefined);
    const refresh = refreshWindowsPath({ Path: 'C:\\MixedCase\\tools', PATH: '' }, { execFile });
    expect(refresh.path).toBe('C:\\Windows;C:\\MixedCase\\tools');
  });

  it('reports startup when nothing at all came back, not an empty PATH', () => {
    const { execFile } = fakeReg(regOutput(MACHINE_HEADER, ';;;'), undefined);
    expect(refreshWindowsPath({}, { execFile })).toEqual({ source: 'startup' });
  });

  it('does not rewrite an inherited entry that contains a literal %', () => {
    const { execFile } = fakeReg(regOutput(MACHINE_HEADER, 'C:\\Windows'), undefined);
    const refresh = refreshWindowsPath(
      { PATH: 'C:\\Users\\me\\AppData\\50%%\\tools' },
      { execFile },
    );
    expect(refresh.path).toBe('C:\\Windows;C:\\Users\\me\\AppData\\50%%\\tools');
  });
});

describe('withWindowsPath', () => {
  it('leaves exactly one path key, whatever casing the inherited block used', () => {
    // The environment a Windows extension host really has: the name stored as
    // `Path`. `{ ...env, PATH: fresh }` would carry both the stale `Path` and
    // the fresh `PATH`, and which one a program sees is whichever sorts first.
    const inherited: NodeJS.ProcessEnv = {
      Path: 'C:\\Existing\\tools',
      SystemRoot: 'C:\\Windows',
    };
    const result = withWindowsPath(inherited, 'C:\\Windows;C:\\Program Files\\nodejs');
    expect(Object.keys(result).filter((key) => key.toLowerCase() === 'path')).toEqual(['PATH']);
    expect(result.PATH).toBe('C:\\Windows;C:\\Program Files\\nodejs');
    // Everything that is not PATH survives untouched.
    expect(result.SystemRoot).toBe('C:\\Windows');
    // A copy: the caller's block is never mutated, so the extension host keeps
    // its own PATH and only the child, `where` or the probe sees the new one.
    expect(inherited.Path).toBe('C:\\Existing\\tools');
    expect(inherited).not.toHaveProperty('PATH');
  });

  it('replaces a lowercase `path` too, the casing a POSIX or test block uses', () => {
    const result = withWindowsPath({ path: '/usr/bin', HOME: '/root' }, '/usr/local/bin');
    expect(Object.keys(result).filter((key) => key.toLowerCase() === 'path')).toEqual(['PATH']);
    expect(result.PATH).toBe('/usr/local/bin');
    expect(result.HOME).toBe('/root');
  });
});
