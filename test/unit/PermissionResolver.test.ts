import { describe, expect, it } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import { resolveToolPermissions } from '../../src/tools/PermissionResolver';

function configWith(permissions?: ForgeConfig['permissions']): ForgeConfig {
  return {
    models: [{ name: 'test', gguf_path: '/model.gguf' }],
    active_model: 'test',
    llama_server: { binary: '/llama-server' },
    ...(permissions ? { permissions } : {}),
  };
}

describe('resolveToolPermissions', () => {
  it('preserves legacy access when the permissions block is omitted', () => {
    expect([...resolveToolPermissions(configWith())]).toEqual([
      'read',
      'write',
      'delete',
      'terminal',
      'headless',
      'search',
      'fetch',
      'git-read',
      'git-write',
    ]);
  });

  it('uses safe group defaults when the permissions block is present', () => {
    expect([...resolveToolPermissions(configWith({}))]).toEqual(['read', 'write', 'git-read']);
  });

  it('honors every explicit disable and enable independently', () => {
    const allowed = resolveToolPermissions(
      configWith({
        fs: { read: false, write: false, delete: true },
        net: { search: true, fetch: false },
        exec: { terminal: true, headless: false },
        git: { read: false, write: true },
      }),
    );
    expect([...allowed]).toEqual(['delete', 'search', 'terminal', 'git-write']);
  });
});
