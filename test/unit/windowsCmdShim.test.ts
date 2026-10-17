import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildCliProcessInvocation,
  spawnCliProcess,
  waitForCliProcessExit,
} from '../../src/agents/cliProcess';
import {
  buildWindowsCmdShellInvocation,
  needsWindowsCmdShellWrap,
  quoteWindowsArg,
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
      'C:\\Users\\efso office\\AppData\\Roaming\\npm\\codex.cmd',
      ['queue'],
    );
    expect(args[3]).toBe('"C:\\Users\\efso^ office\\AppData\\Roaming\\npm\\codex.cmd queue"');
  });

  it('refuses a line break instead of letting cmd.exe drop the rest of the line', () => {
    expect(() =>
      buildWindowsCmdShellInvocation('C:\\npm\\codex.cmd', ['exec', 'line one\nline two', '--json']),
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

  async function runShim(shimBody: string, args: string[]) {
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
      const invocation = buildCliProcessInvocation(options);
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
    const { argv, invocation } = await runShim(npmShim, args);
    expect(invocation.windowsCmdWrapped).toBe(false);
    expect(argv).toEqual(args);
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
      expect(unwrapNpmCmdShim(native)).toEqual({ file: exe, args: [] });

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
});
