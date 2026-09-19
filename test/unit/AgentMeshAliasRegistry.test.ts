import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getAlias,
  listAliases,
  readAliases,
  registerAlias,
  removeAlias,
  resolveSessionIdentity,
  writeAliases,
} from '../../src/agentMesh/aliasRegistry';

let root: string;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-alias-'));
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('alias registry (§0/§4)', () => {
  it('registers and resolves by alias', () => {
    registerAlias(root, 'codex', {
      agent: 'codex',
      session_id: 'thread-abc',
      registered_at: 1,
      by: 'forge',
    });
    expect(getAlias(root, 'codex')?.session_id).toBe('thread-abc');
    expect(listAliases(root)).toHaveProperty('codex');
  });

  it('resolves alias over the deprecated pin (§0)', () => {
    registerAlias(root, 'codex', {
      agent: 'codex',
      session_id: 'alias-thread',
      registered_at: 1,
      by: 'forge',
    });
    // The alias wins even when a pin is also present.
    expect(resolveSessionIdentity(root, 'codex', 'pin-thread')).toEqual({
      session_id: 'alias-thread',
      fromAlias: true,
    });
  });

  it('falls back to the pin only when no alias exists', () => {
    expect(resolveSessionIdentity(root, 'codex', 'pin-thread')).toEqual({
      session_id: 'pin-thread',
      fromAlias: false,
    });
    expect(resolveSessionIdentity(root, 'codex', undefined)).toBeUndefined();
  });

  it('removes an alias', () => {
    registerAlias(root, 'claude', {
      agent: 'claude',
      session_id: 'sess',
      registered_at: 1,
      by: 'user',
    });
    removeAlias(root, 'claude');
    expect(getAlias(root, 'claude')).toBeUndefined();
  });

  it('reads an absent table as empty (recovery input, not fatal)', () => {
    expect(readAliases(root)).toEqual({});
  });

  it('treats a corrupt table as empty and repairs on the next write', () => {
    fs.writeFileSync(path.join(root, 'aliases.json'), '{not json');
    expect(readAliases(root)).toEqual({});
    registerAlias(root, 'codex', {
      agent: 'codex',
      session_id: 't',
      registered_at: 1,
      by: 'forge',
    });
    expect(getAlias(root, 'codex')?.session_id).toBe('t');
  });

  it('drops malformed entries on read', () => {
    writeAliases(root, {
      good: { agent: 'codex', session_id: 't', registered_at: 1, by: 'forge' },
      bad: { agent: 'nope', session_id: 't' },
      missingId: { agent: 'claude' },
    });
    const table = readAliases(root);
    expect(Object.keys(table)).toEqual(['good']);
  });
});
