import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { listenLoopback } from '../support/listenLoopback';
import { isFetchBlockedPort } from '../../src/util/fetchBlockedPorts';

describe('listenLoopback', () => {
  it('closes and rebinds when the assigned port is blocked by Fetch', async () => {
    const server = createServer();
    const checkedPorts: number[] = [];
    const port = await listenLoopback(server, '127.0.0.1', (candidate) => {
      checkedPorts.push(candidate);
      return checkedPorts.length === 1 || isFetchBlockedPort(candidate);
    });

    try {
      expect(checkedPorts).toHaveLength(2);
      expect(server.listening).toBe(true);
      expect(port).toBe(checkedPorts[1]);
      expect(isFetchBlockedPort(port)).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
