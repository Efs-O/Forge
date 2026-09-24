import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined } }));

import type { ForgeConfig } from '../../src/config/types';
import { versionReportsTag, type InstalledBuild } from '../../src/jobs/actions/llamacppInstall';
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

describe('gitignoredNote', () => {
  it('explains the gitignore skip for a glob', () => {
    expect(gitignoredNote('**/*.yaml')).toMatch(/Globs skip gitignored files/);
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
