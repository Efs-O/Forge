import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { resolveRipgrep, resolveRipgrepBinary } from '../../src/tools/RipgrepResolver';

describe('resolveRipgrepBinary', () => {
  it('prefers VS Code bundled ripgrep when it exists', () => {
    const expected = path.join(
      'C:\\VSCode',
      'node_modules.asar.unpacked',
      '@vscode',
      'ripgrep',
      'bin',
      'rg.exe',
    );
    expect(
      resolveRipgrepBinary('C:\\VSCode', (candidate) => candidate === expected, 'win32', 'x64'),
    ).toBe(expected);
  });

  it.each([
    ['win32', 'x64', 'win32-x64', 'rg.exe'],
    ['win32', 'arm64', 'win32-arm64', 'rg.exe'],
    ['linux', 'x64', 'linux-x64', 'rg'],
    ['linux', 'arm64', 'linux-arm64', 'rg'],
    ['darwin', 'x64', 'darwin-x64', 'rg'],
    ['darwin', 'arm64', 'darwin-arm64', 'rg'],
  ] as const)(
    'resolves the ripgrep-universal %s/%s layout',
    (platform, arch, directory, executable) => {
      const expected = path.join(
        '/application',
        'node_modules.asar.unpacked',
        '@vscode',
        'ripgrep-universal',
        'bin',
        directory,
        executable,
      );
      expect(
        resolveRipgrepBinary('/application', (candidate) => candidate === expected, platform, arch),
      ).toBe(expected);
    },
  );

  it('returns all attempted bundled candidates for diagnostics', () => {
    const result = resolveRipgrep('/application', () => false, 'win32', 'x64');
    expect(result.command).toBe('rg');
    expect(result.candidates).toContain(
      path.join(
        '/application',
        'node_modules.asar.unpacked',
        '@vscode',
        'ripgrep-universal',
        'bin',
        'win32-x64',
        'rg.exe',
      ),
    );
    expect(result.candidates).toContain(
      path.join('/application', 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg.exe'),
    );
  });

  it('falls back to PATH resolution when no bundled binary exists', () => {
    expect(resolveRipgrepBinary('/opt/code', () => false, 'linux')).toBe('rg');
  });
});
