import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SharedRuntimeRegistry, sharedRuntimeKey } from '../../src/backend/SharedRuntimeRegistry';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function registry(): SharedRuntimeRegistry {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shared-runtime-'));
  roots.push(root);
  return new SharedRuntimeRegistry(root);
}

describe('SharedRuntimeRegistry', () => {
  it('publishes a compatible runtime and tracks independent borrower leases', () => {
    const current = registry();
    const key = sharedRuntimeKey({ name: 'gemma', gguf_path: 'N:/models/gemma.gguf' });
    current.publish({ key, model: 'gemma', endpoint: 'http://127.0.0.1:8080', ownerPid: process.pid, createdAt: 'now' });
    expect(current.find(key)?.endpoint).toBe('http://127.0.0.1:8080');
    current.acquireLease(key, 'workspace-a');
    current.acquireLease(key, 'workspace-b');
    expect(current.hasBorrowers(key)).toBe(true);
    current.releaseLease(key, 'workspace-a');
    expect(current.hasBorrowers(key)).toBe(true);
    current.releaseLease(key, 'workspace-b');
    expect(current.hasBorrowers(key)).toBe(false);
  });
});
