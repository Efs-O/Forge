import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  pickExecutable,
  resolveCliExecutable,
} from '../../src/agents/resolveCliExecutable';

// Paths must be absolute on the *running* platform: production uses the
// platform's path.isAbsolute, so a hardcoded `C:\...` is not absolute on POSIX
// CI runners. path.resolve yields a platform-correct absolute path.
const absClaude = path.resolve(path.sep, 'tools', 'claude.exe');
const absMissing = path.resolve(path.sep, 'tools', 'missing.exe');

describe('resolveCliExecutable', () => {
  it('returns an absolute path unchanged when it exists on disk', async () => {
    const exists = vi.fn(() => true);
    const result = await resolveCliExecutable(absClaude, 'claude', { exists });
    expect(result).toBe(absClaude);
    expect(exists).toHaveBeenCalledWith(absClaude);
  });

  it('throws a clear error for a configured absolute path that does not exist', async () => {
    const exists = vi.fn(() => false);
    await expect(
      resolveCliExecutable(absMissing, 'codex', { exists }),
    ).rejects.toThrow(`codex CLI not found at configured path "${absMissing}" — install it and log in.`);
  });

  it('resolves a bare name via the PATH lookup dependency', async () => {
    const which = vi.fn(async (name: string) => `/usr/local/bin/${name}`);
    const result = await resolveCliExecutable('claude', 'claude', { which });
    expect(result).toBe('/usr/local/bin/claude');
    expect(which).toHaveBeenCalledWith('claude');
  });

  it('throws the install-and-log-in error when PATH lookup fails', async () => {
    const which = vi.fn(async () => {
      throw new Error('not found');
    });
    await expect(resolveCliExecutable('codex', 'codex', { which })).rejects.toThrow(
      'codex CLI not found on PATH — install it and log in.',
    );
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
});
