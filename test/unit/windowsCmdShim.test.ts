import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCliProcessInvocation,
  spawnCliProcess,
  waitForCliProcessExit,
  type CliInvocationDeps,
} from '../../src/agents/cliProcess';
import {
  buildWindowsCmdShellInvocation,
  needsWindowsCmdShellWrap,
  quoteWindowsArg,
  resolveShimNodeExecutable,
  unwrapNpmCmdShim,
} from '../../src/agents/windowsCmdShim';

describe('needsWindowsCmdShellWrap', () => {
  it('flags .cmd and .bat shims', () => {
    expect(needsWindowsCmdShellWrap('C:\\npm\\claude.cmd')).toBe(true);
    expect(needsWindowsCmdShellWrap('C:\\npm\\codex.BAT')).toBe(true);
  });

  it('leaves real executables alone', () => {
    expect(needsWindowsCmdShellWrap('C:\\tools\\claude.exe')).toBe(false);
    expect(needsWindowsCmdShellWrap('claude')).toBe(false);
  });
});

describe('quoteWindowsArg', () => {
  it('leaves plain args unquoted', () => {
    expect(quoteWindowsArg('plain')).toBe('plain');
  });

  it('quotes args containing spaces', () => {
    expect(quoteWindowsArg('C:\\Program Files\\node.exe')).toBe('"C:\\Program Files\\node.exe"');
  });

  it('escapes embedded double quotes', () => {
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('doubles trailing backslashes before the closing quote', () => {
    expect(quoteWindowsArg('C:\\dir with space\\')).toBe('"C:\\dir with space\\\\"');
  });
});

describe('buildWindowsCmdShellInvocation', () => {
  it('joins the quoted executable and args into one cmd.exe /c command line', () => {
    const { file, args } = buildWindowsCmdShellInvocation('C:\\npm\\claude.cmd', [
      '-p',
      'multi word task',
    ]);
    expect(file.toLowerCase()).toContain('cmd.exe');
    expect(args[0]).toBe('/d');
    expect(args[1]).toBe('/s');
    expect(args[2]).toBe('/c');
    // Outer pair for `/s`; inside it cmd sees only escaped quotes and spaces,
    // twice over for the shim's own `%*` pass.
    expect(args[3]).toBe('"C:\\npm\\claude.cmd -p ^^^"multi^^^ word^^^ task^^^""');
  });

  it('holds a spaced executable path together with escaped spaces', () => {
    const { args } = buildWindowsCmdShellInvocation(
      'C:\\Users\\jo smith\\AppData\\Roaming\\npm\\codex.cmd',
      ['queue'],
    );
    expect(args[3]).toBe('"C:\\Users\\jo^ smith\\AppData\\Roaming\\npm\\codex.cmd queue"');
  });

  it('refuses a line break instead of letting cmd.exe drop the rest of the line', () => {
    expect(() =>
      buildWindowsCmdShellInvocation('C:\\npm\\codex.cmd', [
        'exec',
        'line one\nline two',
        '--json',
      ]),
    ).toThrow(/Argument 2 .* line break/);
  });
});

// A real `.cmd` shim, shaped like npm's (it forwards `%*`), run through the
// exact spawn path the CLI agents use. Before the caret escaping, `x&whoami`
// ran `whoami` and `%PATH%` expanded (U03-01).
describe.runIf(process.platform === 'win32')('cmd shim round trip', () => {
  const payloads = [
    'multi word task',
    'x&whoami',
    '" & echo injected & "',
    'a|b',
    '<in >out',
    '%PATH%',
    '%%',
    '!PATH!',
    '^caret^',
    '(paren) [bracket] ;comma, `tick`',
    'say "hi"',
    'C:\\dir with space\\',
    'back\\\\"slash',
    '* ? wildcards',
    '',
  ];

  async function runShim(
    shimBody: string,
    args: string[],
    deps: CliInvocationDeps = { execFile: () => undefined },
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge shim '));
    try {
      const scriptDir = path.join(dir, 'node_modules', 'echo');
      fs.mkdirSync(scriptDir, { recursive: true });
      fs.writeFileSync(
        path.join(scriptDir, 'echo.js'),
        'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
      );
      const shim = path.join(dir, 'echo.cmd');
      fs.writeFileSync(shim, shimBody);
      const options = { executable: shim, args, cwd: dir };
      // `execFile` is faked so this suite never reads the real registry: the
      // round trip is about argv delivery, not about PATH discovery.
      const invocation = buildCliProcessInvocation(options, process.platform, deps);
      const proc = spawnCliProcess(options, invocation);
      let stdout = '';
      proc.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      const exit = await waitForCliProcessExit(proc);
      expect(exit.code).toBe(0);
      return { argv: JSON.parse(stdout) as string[], invocation };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('delivers every argument unchanged through cmd.exe', async () => {
    const { argv, invocation } = await runShim(
      `@"${process.execPath}" "%~dp0\\node_modules\\echo\\echo.js" %*\r\n`,
      payloads,
    );
    expect(invocation.windowsCmdWrapped).toBe(true);
    expect(argv).toEqual(payloads);
  });

  it('runs an npm shim target directly, line breaks included', async () => {
    // The launch line npm's cmd-shim writes for a node script.
    const npmShim =
      '@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nSET "_prog=node"\r\n' +
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  ' +
      '"%dp0%\\node_modules\\echo\\echo.js" %*\r\n';
    const args = [...payloads, 'line one\nline two', '--after'];
    // The case that would have caught the laptop: no `node.exe` beside the
    // shim, so the launcher has to be resolved absolutely — here to the very
    // Node running this test — and never handed to `spawn` as the bare name
    // `node`, which resolves against the child's PATH and died ENOENT.
    const { argv, invocation } = await runShim(npmShim, args, {
      execFile: () => undefined,
      which: () => process.execPath,
    });
    expect(invocation.file).toBe(process.execPath);
    expect(invocation.windowsCmdWrapped).toBe(false);
    expect(argv).toEqual(args);
  });
});

/** The launch line npm's cmd-shim writes for a node script, byte for byte as
 *  `codex.cmd` carries it on this machine, in a real temp tree so the target
 *  exists on the POSIX CI runners too — `platform` is passed explicitly to
 *  `buildCliProcessInvocation`, and the paths here are the platform's own. */
function npmNodeScriptTree(packageName: string): { dir: string; shim: string; target: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-npm-shim-'));
  const target = path.join(dir, 'node_modules', ...packageName.split('/'), 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '// node script\n');
  const shim = path.join(dir, 'codex.cmd');
  fs.writeFileSync(
    shim,
    '@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nSET "_prog=node"\r\n' +
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  ' +
      `"%dp0%\\node_modules\\${packageName.replace(/\//g, '\\')}\\bin\\codex.js" %*\r\n`,
  );
  return { dir, shim, target };
}

describe('resolveShimNodeExecutable', () => {
  const NODE_ERROR =
    "Node.js not found, needed to run codex. Install Node (winget install OpenJS.NodeJS.LTS), or set `cli` to the CLI's own executable.";

  it('prefers a node.exe beside the shim, the rule npm writes into the shim itself', () => {
    const dir = 'C:\\npm';
    const beside = path.win32.join(dir, 'node.exe');
    const exists = vi.fn((candidate: string) => candidate === beside);
    const which = vi.fn(() => 'C:\\Program Files\\nodejs\\node.exe');
    expect(
      resolveShimNodeExecutable(dir, 'codex', 'C:\\Program Files\\nodejs', { exists, which }),
    ).toBe(beside);
    expect(which).not.toHaveBeenCalled();
  });

  it('searches the PATH it is handed when nothing sits beside the shim', () => {
    const exists = vi.fn(() => false);
    const which = vi.fn((program: string, pathValue: string) =>
      pathValue.includes('nodejs')
        ? path.win32.join('C:\\Program Files\\nodejs', program)
        : undefined,
    );
    const found = resolveShimNodeExecutable(
      'C:\\Users\\me\\npm',
      'codex',
      'C:\\Windows;C:\\Program Files\\nodejs',
      { exists, which },
    );
    // Never the bare name: `spawn` would resolve it against the child's PATH,
    // which is VS Code's startup snapshot, and report `spawn node ENOENT`.
    expect(found).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(found).not.toBe('node');
    expect(which).toHaveBeenCalledWith('node.exe', 'C:\\Windows;C:\\Program Files\\nodejs');
  });

  it('refuses with the fix named when Node is nowhere on the PATH', () => {
    const exists = vi.fn(() => false);
    const which = vi.fn(() => undefined);
    expect(() =>
      resolveShimNodeExecutable('C:\\Users\\me\\npm', 'codex', 'C:\\Windows', { exists, which }),
    ).toThrow(NODE_ERROR);
  });

  describe.runIf(process.platform === 'win32')('the default probe', () => {
    it("searches the PATH it is handed, through the repo's one where.exe probe", () => {
      // No `which` is injected, so this is the production path: `systemProbe()`
      // in `src/tools/execProgramResolver.ts`, handed the PATH it must search.
      // `where` follows the environment block it is given, so a node.exe that is
      // nowhere in `process.env.PATH` is still found, and one that IS on the
      // inherited PATH but not in the handed one must not be picked instead.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-where-probe-'));
      try {
        const onPath = path.join(dir, 'on-path');
        const elsewhere = path.join(dir, 'elsewhere');
        fs.mkdirSync(onPath);
        fs.mkdirSync(elsewhere);
        fs.writeFileSync(path.join(onPath, 'node.exe'), '');
        fs.writeFileSync(path.join(elsewhere, 'node.exe'), '');
        // The handed block replaces the inherited one for the probe's own child
        // too, so `where.exe` itself has to be inside it. `elsewhere` is on
        // neither PATH, which is what makes `onPath` the discriminating answer.
        const handed = [
          path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
          onPath,
        ].join(path.win32.delimiter);
        const found = resolveShimNodeExecutable(path.join(dir, 'npm'), 'codex', handed, {
          exists: fs.existsSync,
        });
        // `where.exe` answers with the long spelling of a path while `os.tmpdir()`
        // hands back the 8.3 short form of this profile, so the same folder has
        // two spellings that are never string-equal. Compare the file itself: the
        // launcher must be the one in `onPath` — the PATH that was handed over —
        // and not the one in `elsewhere`, which is on neither PATH.
        expect(fs.statSync(found).ino).toBe(fs.statSync(path.join(onPath, 'node.exe')).ino);
        expect(path.win32.basename(found).toLowerCase()).toBe('node.exe');
        // Never the bare name `node`, which `spawn` would resolve against the
        // child's PATH and report as `spawn node ENOENT`.
        expect(found).not.toBe('node');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('unwrapNpmCmdShim', () => {
  it('resolves a native-exe shim and ignores anything else', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shim-'));
    try {
      const exe = path.join(dir, 'node_modules', 'tool', 'tool.exe');
      fs.mkdirSync(path.dirname(exe), { recursive: true });
      fs.writeFileSync(exe, '');
      const native = path.join(dir, 'tool.cmd');
      fs.writeFileSync(native, '@echo off\r\n"%dp0%\\node_modules\\tool\\tool.exe"   %*\r\n');
      const which = vi.fn();
      expect(unwrapNpmCmdShim(native, { which })).toEqual({ file: exe, args: [] });
      // claude.cmd's launch line is a native exe: it must not be held hostage
      // by Node being installed or not.
      expect(which).not.toHaveBeenCalled();

      const missing = path.join(dir, 'gone.cmd');
      fs.writeFileSync(missing, '"%dp0%\\node_modules\\gone\\gone.exe"   %*\r\n');
      expect(unwrapNpmCmdShim(missing)).toBeUndefined();

      const other = path.join(dir, 'copilot.bat');
      fs.writeFileSync(other, '@echo off\r\npowershell -File "x.ps1" %*\r\n');
      expect(unwrapNpmCmdShim(other)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs a node-script shim through an absolute node, never the bare name', () => {
    const tree = npmNodeScriptTree('@openai/codex');
    try {
      const which = vi.fn(() => 'C:\\Program Files\\nodejs\\node.exe');
      expect(
        unwrapNpmCmdShim(tree.shim, {
          nodePath: 'C:\\Windows;C:\\Program Files\\nodejs',
          cliLabel: 'codex',
          which,
        }),
      ).toEqual({ file: 'C:\\Program Files\\nodejs\\node.exe', args: [tree.target] });
      expect(which).toHaveBeenCalledWith('node.exe', 'C:\\Windows;C:\\Program Files\\nodejs');
    } finally {
      fs.rmSync(tree.dir, { recursive: true, force: true });
    }
  });

  it('refuses instead of handing back the bare name when Node is not there', () => {
    const tree = npmNodeScriptTree('@openai/codex');
    try {
      expect(() =>
        unwrapNpmCmdShim(tree.shim, {
          nodePath: 'C:\\Windows',
          cliLabel: 'codex',
          which: () => undefined,
        }),
      ).toThrow(
        "Node.js not found, needed to run codex. Install Node (winget install OpenJS.NodeJS.LTS), or set `cli` to the CLI's own executable.",
      );
    } finally {
      fs.rmSync(tree.dir, { recursive: true, force: true });
    }
  });
});

/** Issue 1 and issue 3 wired together: the PATH the registry holds is what the
 *  shim's launcher is searched for, and the answer travels with the invocation
 *  so the child gets the same PATH. */
describe('buildCliProcessInvocation PATH decision', () => {
  // Enough of reg.exe's shape for the PATH decision; windowsUserPath.test.ts
  // tests the parsing against the real program's output itself.
  const REG_MACHINE =
    'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n' +
    '    Path    REG_EXPAND_SZ    %SystemRoot%;C:\\Program Files\\nodejs\\\r\n\r\n';
  const REG_USER =
    'HKEY_CURRENT_USER\\Environment\r\n' +
    '    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Roaming\\npm\r\n\r\n';
  const BASE_ENV: NodeJS.ProcessEnv = {
    PATH: 'C:\\Existing\\tools',
    SystemRoot: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\me',
  };

  function npmShimTree(): { dir: string; shim: string; target: string } {
    return npmNodeScriptTree('@openai/codex');
  }

  it('resolves node from the refreshed PATH and reports where the PATH came from', () => {
    const tree = npmShimTree();
    try {
      const which = vi.fn((program: string, pathValue: string) =>
        pathValue.includes('nodejs')
          ? path.win32.join('C:\\Program Files\\nodejs', program)
          : undefined,
      );
      const invocation = buildCliProcessInvocation(
        { executable: tree.shim, args: ['app-server', '--stdio'], cwd: tree.dir },
        'win32',
        {
          execFile: (_f, args) => (String(args[1]).startsWith('HKLM') ? REG_MACHINE : REG_USER),
          which,
          env: BASE_ENV,
        },
      );
      expect(invocation.file).toBe('C:\\Program Files\\nodejs\\node.exe');
      expect(invocation.file).not.toBe('node');
      expect(invocation.args).toEqual([tree.target, 'app-server', '--stdio']);
      expect(invocation.windowsCmdWrapped).toBe(false);
      expect(invocation.pathSource).toBe('fresh');
      // The search saw the registry's Node folder, not the startup snapshot
      // that lacked it: machine, then user, then what VS Code already had.
      expect(which.mock.calls[0]?.[1]).toBe(
        'C:\\Windows;C:\\Program Files\\nodejs\\;C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Existing\\tools',
      );
      expect(invocation.refreshedPath).toBe(which.mock.calls[0]?.[1]);
    } finally {
      fs.rmSync(tree.dir, { recursive: true, force: true });
    }
  });

  it('searches the PATH the child actually gets when the registry cannot answer', () => {
    const tree = npmShimTree();
    try {
      const which = vi.fn(() => 'C:\\Program Files\\nodejs\\node.exe');
      const invocation = buildCliProcessInvocation(
        { executable: tree.shim, args: [], cwd: tree.dir },
        'win32',
        { execFile: () => undefined, which, env: BASE_ENV },
      );
      expect(invocation.pathSource).toBe('startup');
      expect(invocation.refreshedPath).toBeUndefined();
      expect(which.mock.calls[0]?.[1]).toBe('C:\\Existing\\tools');
      expect(invocation.file).toBe('C:\\Program Files\\nodejs\\node.exe');
    } finally {
      fs.rmSync(tree.dir, { recursive: true, force: true });
    }
  });

  it('reads the registry for a plain .exe too, because the child env is the point', () => {
    const execFile = vi.fn(() => REG_MACHINE);
    const invocation = buildCliProcessInvocation(
      { executable: 'C:\\codex\\codex.exe', args: ['login'], cwd: 'C:\\' },
      'win32',
      { execFile, env: BASE_ENV },
    );
    expect(invocation.file).toBe('C:\\codex\\codex.exe');
    expect(invocation.pathSource).toBe('fresh');
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('reads nothing on POSIX, where nothing needs it', () => {
    const execFile = vi.fn(() => REG_MACHINE);
    const invocation = buildCliProcessInvocation(
      { executable: '/usr/local/bin/codex', args: ['login'], cwd: '/tmp' },
      'linux',
      { execFile },
    );
    expect(invocation.file).toBe('/usr/local/bin/codex');
    expect(invocation.pathSource).toBe('startup');
    expect(execFile).not.toHaveBeenCalled();
  });
});
