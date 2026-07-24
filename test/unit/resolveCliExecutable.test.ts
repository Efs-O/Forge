import { describe, expect, it, vi } from 'vitest';
import { resolveCliExecutable } from '../../src/agents/resolveCliExecutable';

describe('resolveCliExecutable', () => {
  it('returns an absolute path unchanged when it exists on disk', async () => {
    const exists = vi.fn(() => true);
    const result = await resolveCliExecutable('C:\\tools\\claude.exe', 'claude', { exists });
    expect(result).toBe('C:\\tools\\claude.exe');
    expect(exists).toHaveBeenCalledWith('C:\\tools\\claude.exe');
  });

  it('throws a clear error for a configured absolute path that does not exist', async () => {
    const exists = vi.fn(() => false);
    await expect(
      resolveCliExecutable('C:\\tools\\missing.exe', 'codex', { exists }),
    ).rejects.toThrow('codex CLI not found at configured path "C:\\tools\\missing.exe" — install it and log in.');
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
});
