import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { resolveRipgrepBinary } from '../../src/tools/RipgrepResolver';

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
    expect(resolveRipgrepBinary('C:\\VSCode', (candidate) => candidate === expected, 'win32')).toBe(
      expected,
    );
  });

  it('falls back to PATH resolution when no bundled binary exists', () => {
    expect(resolveRipgrepBinary('/opt/code', () => false, 'linux')).toBe('rg');
  });
});
