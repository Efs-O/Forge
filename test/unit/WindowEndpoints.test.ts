import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { busPaths, type BusPaths } from '../../src/agentBus/agentBus';
import { AgentWindowEndpointRegistry } from '../../src/backend/agentWindowEndpointRegistry';
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

describe('shared endpoint.json ownership', () => {
  const DEAD = 999_001;
  const OTHER = 999_002;
  const isAlive = (pid: number) => pid !== DEAD;
  const otherWindow = {
    windowId: '00000000-0000-4000-8000-000000000051',
    url: 'http://127.0.0.1:2',
    token: 'o'.repeat(64),
    pid: OTHER,
  };
  let home: string;
  let paths: BusPaths;
  let focused: boolean;

  const registry = (n: number) =>
    new AgentWindowEndpointRegistry(
      () => paths,
      () => focused,
      String(n).repeat(64),
      `00000000-0000-4000-8000-00000000006${n}`,
      isAlive,
    );
  const start = (n: number) => {
    const r = registry(n);
    r.setEnabled(true);
    r.onListening(`http://127.0.0.1:4000${n}`);
    return r;
  };
  const shared = () => JSON.parse(fs.readFileSync(paths.endpoint, 'utf8')) as { token: string };
  const writeShared = (value: unknown) => {
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(paths.endpoint, typeof value === 'string' ? value : JSON.stringify(value));
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-endpoint-owner-'));
    paths = busPaths(home);
    focused = false;
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('an unfocused window publishes when endpoint.json is missing', () => {
    start(1);
    expect(shared().token).toBe('1'.repeat(64));
  });

  it('an unfocused window leaves a live owner alone', () => {
    writeShared(otherWindow);
    start(1);
    expect(shared().token).toBe(otherWindow.token);
  });

  it('an unfocused window replaces a dead owner or a corrupt file', () => {
    writeShared({ ...otherWindow, pid: DEAD });
    const r = start(1);
    expect(shared().token).toBe('1'.repeat(64));
    writeShared('{not json');
    r.claim();
    expect(shared().token).toBe('1'.repeat(64));
  });

  it('a focused window always publishes', () => {
    writeShared(otherWindow);
    focused = true;
    start(1);
    expect(shared().token).toBe('1'.repeat(64));
  });

  it('a closing owner hands endpoint.json to another live window', () => {
    const first = start(1);
    start(2);
    expect(shared().token).toBe('1'.repeat(64));
    first.dispose();
    expect(shared().token).toBe('2'.repeat(64));
  });

  it('a closing owner removes endpoint.json when no live window is left', () => {
    writeWindowEndpoint(paths.root, { ...otherWindow, pid: DEAD });
    const only = start(1);
    only.dispose();
    expect(fs.existsSync(paths.endpoint)).toBe(false);
  });

  it('disabling the bus hands endpoint.json off as well', () => {
    const first = start(1);
    start(2);
    first.setEnabled(false);
    expect(shared().token).toBe('2'.repeat(64));
  });

  it('a closing non-owner leaves endpoint.json untouched', () => {
    start(1);
    const second = start(2);
    second.dispose();
    expect(shared().token).toBe('1'.repeat(64));
  });
});
