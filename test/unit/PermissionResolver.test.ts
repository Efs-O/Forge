import { describe, expect, it } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import {
  permissionsSuppressedByBlock,
  resolveToolPermissions,
} from '../../src/tools/PermissionResolver';

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

  it('never grants delegate via the legacy fallback or group defaults', () => {
    expect(resolveToolPermissions(configWith()).has('delegate')).toBe(false);
    expect(resolveToolPermissions(configWith({})).has('delegate')).toBe(false);
    expect(resolveToolPermissions(configWith({ agents: {} })).has('delegate')).toBe(false);
  });

  it('grants delegate only on an explicit agents.delegate: true', () => {
    const allowed = resolveToolPermissions(configWith({ agents: { delegate: true } }));
    expect(allowed.has('delegate')).toBe(true);
    // delegation opt-in must not widen any other group past its defaults
    expect([...allowed]).toEqual(['read', 'write', 'git-read', 'delegate']);
  });

  it('accepts the deprecated cloud_workers key but grants nothing for it', () => {
    // dispatch_workers is gone; the key stays schema-valid only so an existing
    // config.yaml keeps booting. It must not widen the capability set.
    const allowed = resolveToolPermissions(
      configWith({ agents: { delegate: true, cloud_workers: true } }),
    );
    expect([...allowed]).toEqual(['read', 'write', 'git-read', 'delegate']);
  });
});

// The block is all-or-nothing: naming one group makes the schema defaults
// authoritative for every other group, so a capability can go dark without
// ever being switched off. The only symptom is a missing tool.
describe('permissionsSuppressedByBlock', () => {
  it('reports nothing when no permissions block is present', () => {
    expect(permissionsSuppressedByBlock(configWith())).toEqual([]);
  });

  it('names the config keys that adding one group silently switched off', () => {
    expect(permissionsSuppressedByBlock(configWith({ fs: { delete: true } }))).toEqual([
      'exec.terminal',
      'exec.headless',
      'net.search',
      'net.fetch',
      'git.write',
    ]);
  });

  // The shipped example config denies most of these deliberately. Warning about
  // a decision someone already made trains people to ignore the message.
  it('stays silent about capabilities that were explicitly denied', () => {
    const permissions = {
      fs: { read: true, write: true, delete: false },
      net: { search: false, fetch: false },
      exec: { terminal: false, headless: false },
      git: { read: true, write: false },
    };
    expect(permissionsSuppressedByBlock(configWith(permissions))).toEqual([]);
  });

  it('reports nothing when every legacy capability is granted back', () => {
    const permissions = {
      fs: { delete: true },
      net: { search: true, fetch: true },
      exec: { terminal: true, headless: true },
      git: { write: true },
    };
    expect(permissionsSuppressedByBlock(configWith(permissions))).toEqual([]);
  });
});
