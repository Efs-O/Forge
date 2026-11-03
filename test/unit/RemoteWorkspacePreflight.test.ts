/**
 * The phase 2b preflight: what the window a switch opens will load, and whether
 * it can answer the phone. These are the cases the plan names — the config coming
 * from the user setting, from the target folder, and from a `.code-workspace`
 * file — plus the refusals that used to be invisible: remote off, the asked
 * channel off, and a workspace file whose folders point somewhere else.
 *
 * The precedence is `ConfigLoader.findConfigPathFor`'s: explicit setting, then
 * the workspace root's `.forge/config.yaml`, then global storage — with the root
 * for a workspace file being its **first folder**, not the file's own directory.
 * `forge.configFile` is machine-scoped, so nothing a folder or workspace file
 * pins can change it: the tests that used to assert the opposite asserted a rule
 * VS Code does not apply, and now assert that the pin is ignored.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  preflightRemoteWorkspaceSwitch,
  type WorkspacePreflight,
  type WorkspacePreflightDeps,
} from '../../src/remote/remoteWorkspacePreflight';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function directory(prefix: string): Promise<string> {
  const made = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(made);
  return made;
}

/** A folder inside a temp directory already being cleaned up — what a
 *  `.code-workspace` file and its first folder have to be for one of these to
 *  be resolvable against the other. */
async function subDirectory(parent: string, name: string): Promise<string> {
  const made = path.join(parent, name);
  await fs.mkdir(made, { recursive: true });
  return made;
}

const configYaml = (enabled: boolean, telegram: boolean): string =>
  [
    'models:',
    '  - name: m',
    '    provider: ollama',
    '    endpoint: http://127.0.0.1:11434',
    'remote:',
    `  enabled: ${enabled}`,
    '  telegram:',
    `    enabled: ${telegram}`,
    '',
  ].join('\n');

/** Write the config a window would load from `<root>/.forge/config.yaml`. */
async function writeForgeConfig(root: string, enabled = true, telegram = true): Promise<string> {
  const forgeDir = path.join(root, '.forge');
  await fs.mkdir(forgeDir, { recursive: true });
  const file = path.join(forgeDir, 'config.yaml');
  await fs.writeFile(file, configYaml(enabled, telegram), 'utf8');
  return file;
}

/** The config a window with **no** workspace root would load: global storage
 *  keeps `config.yaml` at its top level, not inside a `.forge` folder. */
async function writeGlobalConfig(
  storage: string,
  enabled = true,
  telegram = true,
): Promise<string> {
  await fs.mkdir(storage, { recursive: true });
  const file = path.join(storage, 'config.yaml');
  await fs.writeFile(file, configYaml(enabled, telegram), 'utf8');
  return file;
}

/** A refusal, narrowed, so each test can assert on the reason it is checking. */
function reasonOf(outcome: WorkspacePreflight): string {
  expect(outcome.ok).toBe(false);
  return (outcome as { ok: false; reason: string }).reason;
}

function preflight(
  targetPath: string,
  overrides: Partial<WorkspacePreflightDeps> = {},
): WorkspacePreflight {
  return preflightRemoteWorkspaceSwitch({
    targetPath,
    channel: 'telegram',
    globalStoragePath: path.join(os.tmpdir(), 'forge-preflight-unused'),
    ...overrides,
  });
}

/** A `.code-workspace` file, written the way VS Code writes one: `folders`
 *  entries whose relative `path` is resolved against the file itself. */
async function writeWorkspaceFile(file: string, body: Record<string, unknown>): Promise<string> {
  await fs.writeFile(file, JSON.stringify(body), 'utf8');
  return file;
}

const jsonString = (value: string): string => value.replace(/\\/g, '\\\\');

describe('workspace switch preflight', () => {
  it('accepts a target whose own config can answer the phone', async () => {
    const target = await directory('forge-preflight-target-');
    const configPath = await writeForgeConfig(target);
    const outcome = preflight(target);
    expect(outcome.ok).toBe(true);
    expect((outcome as { configPath: string }).configPath).toBe(configPath);
  });

  it('refuses a target that starts with remote off, and names the file', async () => {
    const target = await directory('forge-preflight-off-');
    const configPath = await writeForgeConfig(target, false);
    const reason = reasonOf(preflight(target));
    expect(reason).toContain('remote off');
    expect(reason).toContain(configPath);
  });

  it('refuses when remote is on but the asked channel is off', async () => {
    const target = await directory('forge-preflight-channel-');
    await writeForgeConfig(target, true, false);
    expect(reasonOf(preflight(target))).toContain('telegram off');
  });

  /**
   * The precedence the audit caught: `forge.configFile` is `"scope": "machine"`
   * (`package.json`:463), so VS Code refuses it in a folder's
   * `.vscode/settings.json` ("This setting cannot be applied in this workspace")
   * and the window that opens this folder reads the user value instead. A pin
   * here is therefore something to ignore, not to honour — honouring it would
   * approve or refuse on a file the target window will not load.
   */
  it('ignores a forge.configFile the target folder pins, which VS Code will not apply', async () => {
    const target = await directory('forge-preflight-pin-');
    const loaded = await writeForgeConfig(target, true, true);
    const pinned = await writeForgeConfig(
      await directory('forge-preflight-pin-elsewhere-'),
      false,
      true,
    );
    await fs.mkdir(path.join(target, '.vscode'), { recursive: true });
    // Comments and a trailing comma, which VS Code allows in settings files:
    // none of it changes anything, because the setting itself is ignored here.
    await fs.writeFile(
      path.join(target, '.vscode', 'settings.json'),
      `// pinned by hand\n{ "forge.configFile": "${jsonString(pinned)}", }`,
      'utf8',
    );
    const outcome = preflight(target);
    expect(outcome.ok).toBe(true);
    expect((outcome as { configPath: string }).configPath).toBe(loaded);
  });

  it('ignores a forge.configFile a .code-workspace settings block pins, for the same reason', async () => {
    const parent = await directory('forge-preflight-ws-pin-');
    const inside = await writeForgeConfig(path.join(parent, 'project'), true, true);
    const pinned = await writeForgeConfig(
      await directory('forge-preflight-ws-pin-elsewhere-'),
      false,
      true,
    );
    const workspaceFile = await writeWorkspaceFile(path.join(parent, 'project.code-workspace'), {
      folders: [{ path: jsonString(path.join(parent, 'project')) }],
      settings: { 'forge.configFile': jsonString(pinned) },
    });
    const outcome = preflight(workspaceFile);
    expect(outcome.ok).toBe(true);
    expect((outcome as { configPath: string }).configPath).toBe(inside);
  });

  /** An explicit setting beats the folder `.forge/config.yaml`, which is
   *  `findConfigPath`'s order and not the other way round — and it is the only
   *  scope at which this machine-scoped setting can be set at all. */
  it('follows the user setting over the target folder own config', async () => {
    const target = await directory('forge-preflight-user-');
    await writeForgeConfig(target, true, true);
    const elsewhere = await directory('forge-preflight-user-elsewhere-');
    const fromUser = await writeForgeConfig(elsewhere, false);
    expect(reasonOf(preflight(target, { userConfigFileSetting: fromUser }))).toContain(fromUser);
  });

  /**
   * What a workspace file *does* change: the folder the target window treats as
   * its root. `vscode.workspace.workspaceFolders[0]` is the first entry in
   * `folders`, resolved against the file's own directory, so a workspace file
   * living next to a good config can point the new window somewhere else — and
   * this check has to follow it rather than reading the directory beside it.
   */
  it('uses a .code-workspace file first folder, not the directory the file sits in', async () => {
    const home = await directory('forge-preflight-ws-root-');
    const beside = await subDirectory(home, 'workspace-file-here');
    // The decoy: a config beside the workspace file that would have been
    // approved had the check used `dirname(file)`.
    await writeForgeConfig(beside, true, true);
    const sibling = await subDirectory(home, 'sibling');
    const siblingConfig = await writeForgeConfig(sibling, false, true);
    const workspaceFile = await writeWorkspaceFile(path.join(beside, 'project.code-workspace'), {
      folders: [{ path: '../sibling' }],
    });
    expect(reasonOf(preflight(workspaceFile))).toContain(siblingConfig);
  });

  it('reads a first folder written as a file uri the way VS Code resolves it', async () => {
    const home = await directory('forge-preflight-ws-uri-');
    const beside = await subDirectory(home, 'workspace-file-here');
    await writeForgeConfig(beside, true, true);
    const sibling = await subDirectory(home, 'sibling');
    const siblingConfig = await writeForgeConfig(sibling, false, true);
    const workspaceFile = await writeWorkspaceFile(path.join(beside, 'project.code-workspace'), {
      folders: [{ uri: pathToFileURL(sibling).href }],
    });
    expect(reasonOf(preflight(workspaceFile))).toContain(siblingConfig);
  });

  it('keeps reading a workspace file that carries comments', async () => {
    const home = await directory('forge-preflight-ws-jsonc-');
    const sibling = await subDirectory(home, 'sibling');
    const siblingConfig = await writeForgeConfig(sibling, false, true);
    const workspaceFile = path.join(home, 'project.code-workspace');
    await fs.writeFile(
      workspaceFile,
      `// hand-edited\n{ "folders": [ { "path": "sibling" } ], }`,
      'utf8',
    );
    expect(reasonOf(preflight(workspaceFile))).toContain(siblingConfig);
  });

  /**
   * A workspace file with no folders — or one this window cannot parse — leaves
   * the target window with no workspace root either, so global storage is all
   * there is. Refusing to guess is what matches the window that comes up, and
   * the reason has to name what it actually checked.
   */
  it('falls back to global storage when the workspace file names no readable folder', async () => {
    const home = await directory('forge-preflight-ws-empty-');
    const global = await subDirectory(home, 'global-storage');
    const globalConfig = await writeGlobalConfig(global, false, true);
    const unreadable = path.join(home, 'broken.code-workspace');
    await fs.writeFile(unreadable, '{ not json', 'utf8');
    const broken = reasonOf(preflight(unreadable, { globalStoragePath: global }));
    expect(broken).toContain('remote off');
    expect(broken).toContain(globalConfig);
    const noFolders = await writeWorkspaceFile(path.join(home, 'empty.code-workspace'), {
      folders: [],
      settings: {},
    });
    expect(reasonOf(preflight(noFolders, { globalStoragePath: global }))).toContain(globalConfig);
  });

  /** A `vscode-remote://` folder is a real workspace the target window can
   *  open, but nothing in this window can read it, so the refusal says that
   *  instead of claiming a folder was searched. */
  it('says what was checked when a workspace folder cannot be read from here', async () => {
    const home = await directory('forge-preflight-ws-remote-');
    const global = await subDirectory(home, 'global-storage');
    const workspaceFile = await writeWorkspaceFile(path.join(home, 'project.code-workspace'), {
      folders: [{ uri: 'vscode-remote://wsl+ubuntu/home/dev/project' }],
    });
    const reason = reasonOf(preflight(workspaceFile, { globalStoragePath: global }));
    expect(reason).toContain('no Forge config');
    expect(reason).toContain('folders cannot be read');
    expect(reason).not.toContain('.forge/config.yaml');
  });

  it('refuses a target with no Forge config anywhere', async () => {
    const target = await directory('forge-preflight-none-');
    const global = await directory('forge-preflight-global-');
    expect(reasonOf(preflight(target, { globalStoragePath: global }))).toContain('no Forge config');
  });
});
