import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined } }));

import type { ForgeConfig } from '../../src/config/types';
import {
  findFreePort,
  versionReportsTag,
  type FreePortProbe,
  type InstalledBuild,
} from '../../src/jobs/actions/llamacppInstall';
import { isFetchBlockedPort } from '../../src/util/fetchBlockedPorts';
import { gitignoredNote } from '../../src/tools/dirTools';
import { makeInstallLlamacppTool } from '../../src/tools/llamacppInstallTool';

describe('versionReportsTag', () => {
  it('accepts the tag verbatim', () => {
    expect(versionReportsTag('llama.cpp version b11077', 'b11077')).toBe(true);
  });

  it('accepts the "build NNNN" form real builds print (to stderr)', () => {
    const stderr = 'version: 0.4.1-dev (build 11077, commit 1a2b3c4)\nbuilt with MSVC';
    expect(versionReportsTag(`\n${stderr}`, 'b11077')).toBe(true);
  });

  it('rejects a different build number', () => {
    expect(versionReportsTag('version: 0.4.1-dev (build 110770, commit x)', 'b11077')).toBe(false);
    expect(versionReportsTag('version: 0.4.1-dev (build 11076, commit x)', 'b11077')).toBe(false);
  });
});

describe('findFreePort', () => {
  /**
   * A `net.Server` stand-in that reports each entry of `addresses` in order,
   * in the shapes the real socket reports: an object with a `port`, or `null`
   * when nothing was bound. It never invents a port, so a test that expects a
   *  rebind can count the binds exactly.
   */
  function fakeProbes(addresses: (number | null)[]): {
    createServer: () => FreePortProbe;
    binds: () => number;
  } {
    let binds = 0;
    const next = (): number | null => {
      if (binds >= addresses.length) throw new Error('fake probe ran out of addresses');
      return addresses[binds++];
    };
    return {
      binds: () => binds,
      createServer: () => {
        const address = next();
        return {
          once: (_event, _listener) => undefined,
          listen: (_port, _host, onListening) => {
            onListening?.();
            return undefined;
          },
          address: () => (address === null ? null : { port: address }),
          close: (onClosed) => {
            onClosed();
            return undefined;
          },
        };
      },
    };
  }

  it('binds again while the OS hands back ports fetch would block', async () => {
    const probes = fakeProbes([6000, 6566, 6667, 10080, 41731]);
    expect(await findFreePort('127.0.0.1', probes.createServer)).toBe(41731);
    expect(probes.binds()).toBe(5);
  });

  it('gives up after 32 blocked binds instead of looping forever', async () => {
    const probes = fakeProbes(new Array(32).fill(6000));
    await expect(findFreePort('127.0.0.1', probes.createServer)).rejects.toThrow(
      /no port fetch can reach on 127\.0\.0\.1 after 32 binds/,
    );
    expect(probes.binds()).toBe(32);
  });

  it('says so plainly when the socket reports no port, instead of resolving 0', async () => {
    const probes = fakeProbes([null]);
    await expect(findFreePort('127.0.0.1', probes.createServer)).rejects.toThrow(
      /could not read the port it bound on 127\.0\.0\.1/,
    );
    expect(probes.binds()).toBe(1);
  });

  it('a real bind reports a port fetch can reach', async () => {
    const port = await findFreePort('127.0.0.1');
    expect(port).toBeGreaterThan(0);
    expect(isFetchBlockedPort(port)).toBe(false);
  });
});

describe('gitignoredNote', () => {
  it('explains the gitignore skip for a glob', () => {
    expect(gitignoredNote('**/*.yaml')).toBe(
      ' A glob can skip gitignored files; pass an exact file or folder path, or set include_ignored: true.',
    );
  });

  it('says nothing for an exact path', () => {
    expect(gitignoredNote('.forge/config.yaml')).toBe('');
  });
});

const INSTALLED: InstalledBuild = {
  newBinary: 'C:\\Forge\\llama.cpp-b11077\\llama-server.exe',
  assets: [
    { name: 'llama-b11077-bin-win-cuda-13.4-x64.zip', digest: 'sha256:aa' },
    { name: 'cudart-llama-bin-win-cuda-13.4-x64.zip', digest: 'sha256:bb' },
  ],
};

function makeTool(config: Partial<ForgeConfig>, path: string | null = 'C:\\c.yaml') {
  const configPath = path ?? undefined;
  const install = vi.fn(async () => INSTALLED);
  const setBinary = vi.fn();
  const latestTag = vi.fn(async () => 'b11077');
  const tool = makeInstallLlamacppTool({
    getConfig: () => config as ForgeConfig,
    configPath,
    install,
    latestTag,
    localRoot: () => 'C:\\Forge',
    ...(configPath ? { setBinary } : {}),
  });
  return { tool, install, setBinary, latestTag };
}

const CONFIG: Partial<ForgeConfig> = {
  llama_server: { binary: 'C:\\old\\llama-server.exe' },
  models: [],
  jobs: { allowed_hosts: ['api.github.com', 'github.com'] } as ForgeConfig['jobs'],
};

describe.runIf(process.platform === 'win32')('install_llamacpp', () => {
  it('installs the newest prerelease and switches the binary without restarting', async () => {
    const { tool, install, setBinary, latestTag } = makeTool(CONFIG);
    const out = String(await tool.handler({}));
    expect(latestTag).toHaveBeenCalledWith(['api.github.com', 'github.com']);
    expect(install).toHaveBeenCalledWith(
      'ggml-org/llama.cpp',
      'b11077',
      'llama-*-bin-win-cuda-*-x64.zip',
      expect.objectContaining({ localRoot: 'C:\\Forge' }),
    );
    expect(setBinary).toHaveBeenCalledWith(INSTALLED.newBinary);
    expect(out).toMatch(/switched from C:\\old\\llama-server\.exe/);
    expect(out).toMatch(/NOT restarted/);
  });

  it('a switch deletes the older builds but keeps the one it replaced', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-llama-tool-'));
    try {
      for (const tag of ['b11000', 'b11050', 'b11077']) {
        fs.mkdirSync(path.join(root, `llama.cpp-${tag}`));
      }
      const previous = path.join(root, 'llama.cpp-b11050', 'llama-server.exe');
      const install = vi.fn(async () => ({
        ...INSTALLED,
        newBinary: path.join(root, 'llama.cpp-b11077', 'llama-server.exe'),
      }));
      const tool = makeInstallLlamacppTool({
        getConfig: () => ({ ...CONFIG, llama_server: { binary: previous } }) as ForgeConfig,
        configPath: 'C:\\c.yaml',
        install,
        latestTag: async () => 'b11077',
        localRoot: () => root,
        setBinary: vi.fn(),
      });
      const out = String(await tool.handler({}));
      expect(fs.readdirSync(root).sort()).toEqual(['llama.cpp-b11050', 'llama.cpp-b11077']);
      expect(out).toMatch(/Removed old builds: llama\.cpp-b11000\./);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an installed build as partial and skips pruning when the config switch fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-llama-partial-'));
    const configError = 'cloud_relay entry gemma4:31b-cloud is invalid';
    try {
      for (const tag of ['b11000', 'b11050', 'b11077']) {
        fs.mkdirSync(path.join(root, `llama.cpp-${tag}`));
      }
      const previous = path.join(root, 'llama.cpp-b11050', 'llama-server.exe');
      const setBinary = vi.fn(() => {
        throw new Error(configError);
      });
      const tool = makeInstallLlamacppTool({
        getConfig: () => ({ ...CONFIG, llama_server: { binary: previous } }) as ForgeConfig,
        configPath: 'C:\\c.yaml',
        install: vi.fn(async () => ({
          ...INSTALLED,
          newBinary: path.join(root, 'llama.cpp-b11077', 'llama-server.exe'),
        })),
        latestTag: async () => 'b11077',
        localRoot: () => root,
        setBinary,
      });

      const out = String(await tool.handler({}));
      expect(out).toMatch(/^Partial:/u);
      expect(out).toContain(path.join(root, 'llama.cpp-b11077', 'llama-server.exe'));
      expect(out).toContain('llama_server.binary was NOT switched');
      expect(out).toContain(configError);
      expect(out).toContain('fix the named config entry');
      expect(fs.readdirSync(root).sort()).toEqual(['llama.cpp-b11000', 'llama.cpp-b11050', 'llama.cpp-b11077']);
      expect(setBinary).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves config.yaml alone with switch_config false', async () => {
    const { tool, setBinary, latestTag } = makeTool(CONFIG);
    const out = String(await tool.handler({ tag: 'b11000', switch_config: false }));
    expect(latestTag).not.toHaveBeenCalled();
    expect(setBinary).not.toHaveBeenCalled();
    expect(out).toMatch(/config\.yaml was not changed/);
  });

  it('names jobs.allowed_hosts when nothing may be downloaded', async () => {
    const { tool, install } = makeTool({ llama_server: { binary: 'x' } });
    expect(String(await tool.handler({}))).toMatch(/jobs\.allowed_hosts/);
    expect(install).not.toHaveBeenCalled();
  });

  it('refuses to switch when no config path is known', async () => {
    const { tool, install } = makeTool(CONFIG, null);
    expect(String(await tool.handler({}))).toMatch(/switch_config: false/);
    expect(install).not.toHaveBeenCalled();
  });
});

describe('install_llamacpp advertisement', () => {
  const realPlatform = process.platform;
  const setPlatform = (value: string): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  };
  afterEach(() => setPlatform(realPlatform));

  it('is advertised only when llama_server.binary is set', () => {
    setPlatform('win32');
    expect(makeTool(CONFIG).tool.advertise?.()).toBe(true);
    expect(makeTool({ llama_server: {} }).tool.advertise?.()).toBe(false);
  });

  it('is not advertised off Windows, where it cannot install', () => {
    setPlatform('linux');
    expect(makeTool(CONFIG).tool.advertise?.()).toBe(false);
  });
});
