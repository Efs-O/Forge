import { describe, expect, it } from 'vitest';
import {
  buildWindowsCmdShellInvocation,
  needsWindowsCmdShellWrap,
  quoteWindowsArg,
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
    expect(args[3]).toBe('C:\\npm\\claude.cmd -p "multi word task"');
  });
});
