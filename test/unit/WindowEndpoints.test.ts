import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  removeDeadWindowEndpoints,
  removeWindowEndpoint,
  windowEndpointPath,
  writeWindowEndpoint,
} from '../../src/agentBus/windowEndpoints';

const windowId = '00000000-0000-4000-8000-000000000041';

describe('per-window agent-bus endpoints', () => {
  it('writes atomically, removes dead owners, and deletes only its own endpoint', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-window-endpoint-'));
    try {
      const endpoint = { windowId, url: 'http://127.0.0.1:43121', token: 'x'.repeat(32), pid: 1234 };
      writeWindowEndpoint(root, endpoint);
      expect(JSON.parse(fs.readFileSync(windowEndpointPath(root, windowId), 'utf8'))).toEqual(endpoint);
      expect(removeDeadWindowEndpoints(root, (pid) => pid !== endpoint.pid)).toEqual([windowId]);

      writeWindowEndpoint(root, endpoint);
      removeWindowEndpoint(root, windowId, 'other-token');
      expect(fs.existsSync(windowEndpointPath(root, windowId))).toBe(true);
      removeWindowEndpoint(root, windowId, endpoint.token);
      expect(fs.existsSync(windowEndpointPath(root, windowId))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
