/**
 * What this covers: a `forge.configFile` that points at nothing used to be
 * invisible. `resolveExplicitConfigPath` returns null for a missing path, so
 * `findConfigPath` fell through to the workspace config — or to setup mode —
 * with no message, and a setting left on the wrong machine sat unused for a
 * whole session with nothing on screen saying why the config was not the one
 * the owner expected. `bootstrapConfig` now names the setting, the value it was
 * given, and what it is using instead.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendStatusBar } from '../../src/vscode/BackendStatusBar';
import { bootstrapConfig } from '../../src/vscode/configBootstrap';

const mocks = vi.hoisted(() => ({
  /** The `forge.configFile` setting, read at call time so a test can change it. */
  configFile: undefined as string | undefined,
  /** The same array object the mock hands out, so pushing here is visible. */
  workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  warnings: [] as string[],
  /** Every command `bootstrapConfig` registered itself, recorded so a test can
   *  prove the one its own error message names is really there. */
  registered: [] as Array<{ id: string; run: () => unknown }>,
  /** Stands in for `runPolicyMigration`, so the handler can be invoked without
   *  touching a real policy file or the ACL check the migration asks first. */
  runMigration: vi.fn(() => ({
    movedKeys: ['permissions'],
    alreadyInPolicy: [],
    engines: [],
    model_hosts: [],
    policyPath: '/tmp/policy.yaml',
    backupPath: '/tmp/config.yaml.pre-policy-20261102-235500',
    policyWritten: true,
  })),
  information: vi.fn(async () => undefined),
  /** What `vscode.extensions.getExtension('Efsoo.forge-llm')` reports: undefined
   *  means "not a real host", which is what every other test here wants. */
  extension: undefined as
    | { packageJSON: { version: string }; extensionPath: string }
    | undefined,
  enterSetupMode: vi.fn(),
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: () => mocks.configFile }),
    workspaceFolders: mocks.workspaceFolders,
  },
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      clear: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    }),
    showWarningMessage: (...args: unknown[]) => {
      mocks.warnings.push(args.map((arg) => String(arg)).join(' '));
      return Promise.resolve(undefined);
    },
    showErrorMessage: vi.fn(),
    showInformationMessage: mocks.information,
  },
  commands: {
    executeCommand: vi.fn(async () => undefined),
    registerCommand: (id: string, run: () => unknown) => {
      mocks.registered.push({ id, run });
      return { dispose: () => undefined };
    },
  },
  extensions: {
    getExtension: () => mocks.extension,
  },
}));

// SetupMode registers a webview provider and a command, neither of which this
// mock has; the point here is that activation stopped and setup mode was offered.
vi.mock('../../src/sidebar/SetupMode', () => ({ enterSetupMode: mocks.enterSetupMode }));

// The recovery command's one dependency. Mocked so a test can invoke the
// handler and see WHICH file it was told to migrate, without a real
// `~/.forge/policy.yaml` or a Windows ACL probe behind it.
vi.mock('../../src/config/policyMigration', () => ({
  runPolicyMigration: mocks.runMigration,
}));

const tempDirs: string[] = [];
const VALID_CONFIG = `active_model: m
models:
  - name: m
    provider: ollama
    endpoint: http://127.0.0.1:11434
`;

function mkTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function fakeContext(): { subscriptions: Array<{ dispose(): void }> } {
  return { subscriptions: [] };
}

function statusBar(): BackendStatusBar {
  return { setNoConfig: vi.fn() } as unknown as BackendStatusBar;
}

/** A workspace whose `.forge/config.yaml` is real, as the fallback lookup expects. */
function workspaceWithConfig(): string {
  const root = mkTempDir('forge-bootstrap-ws-');
  fs.mkdirSync(path.join(root, '.forge'));
  fs.writeFileSync(path.join(root, '.forge', 'config.yaml'), VALID_CONFIG, 'utf8');
  mocks.workspaceFolders.push({ uri: { fsPath: root } });
  return root;
}

describe('a forge.configFile that points at nothing', () => {
  beforeEach(() => {
    mocks.configFile = undefined;
    mocks.warnings.length = 0;
    mocks.workspaceFolders.length = 0;
    mocks.extension = undefined;
    mocks.enterSetupMode.mockClear();
    mocks.registered.length = 0;
    mocks.runMigration.mockClear();
    mocks.information.mockClear();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('says so, and names setup mode as what it is using instead', () => {
    const missing = path.join(mkTempDir('forge-bootstrap-setting-'), 'config.yaml');
    mocks.configFile = missing;

    const bootstrapped = bootstrapConfig(
      fakeContext() as unknown as Parameters<typeof bootstrapConfig>[0],
      statusBar(),
      mkTempDir('forge-bootstrap-storage-'),
    );

    expect(bootstrapped).toBeUndefined();
    expect(mocks.enterSetupMode).toHaveBeenCalled();
    expect(mocks.warnings).toHaveLength(1);
    expect(mocks.warnings[0]).toContain(`forge.configFile is "${missing}"`);
    expect(mocks.warnings[0]).toContain('not a config.yaml or a folder holding one');
    expect(mocks.warnings[0]).toContain('Using setup mode instead.');
  });

  /**
   * The 2026-10-27 08:04 failure: the config was valid for the build on disk
   * (0.17.87, which had the fix), but the window that tried to load it had
   * started on 0.17.86 the night before and was never reloaded. A load failure
   * in that state has to say which of the two it is, or the user goes looking
   * for a config error that was never there.
   */
  it('says to reload the window when it runs an older build than the installed one', () => {
    const extensionsDir = mkTempDir('forge-bootstrap-extensions-');
    fs.mkdirSync(path.join(extensionsDir, 'efsoo.forge-llm-0.17.86'));
    fs.mkdirSync(path.join(extensionsDir, 'efsoo.forge-llm-0.17.87'));
    mocks.extension = {
      packageJSON: { version: '0.17.86' },
      extensionPath: path.join(extensionsDir, 'efsoo.forge-llm-0.17.86'),
    };
    const workspaceRoot = mkTempDir('forge-bootstrap-broken-');
    fs.mkdirSync(path.join(workspaceRoot, '.forge'));
    fs.writeFileSync(
      path.join(workspaceRoot, '.forge', 'config.yaml'),
      'models: [unclosed\n',
      'utf8',
    );
    mocks.workspaceFolders.push({ uri: { fsPath: workspaceRoot } });

    const bootstrapped = bootstrapConfig(
      fakeContext() as unknown as Parameters<typeof bootstrapConfig>[0],
      statusBar(),
      mkTempDir('forge-bootstrap-storage-'),
    );

    expect(bootstrapped).toBeUndefined();
    expect(mocks.warnings.join('\n')).toContain(
      'Forge 0.17.87 is installed; this window still runs 0.17.86.',
    );
  });

  it('says nothing about a reload when this window is the newest build', () => {
    const extensionsDir = mkTempDir('forge-bootstrap-extensions-');
    fs.mkdirSync(path.join(extensionsDir, 'efsoo.forge-llm-0.17.87'));
    fs.mkdirSync(path.join(extensionsDir, 'efsoo.forge-llm-0.17.86'));
    mocks.extension = {
      packageJSON: { version: '0.17.87' },
      extensionPath: path.join(extensionsDir, 'efsoo.forge-llm-0.17.87'),
    };
    const workspaceRoot = mkTempDir('forge-bootstrap-broken-');
    fs.mkdirSync(path.join(workspaceRoot, '.forge'));
    fs.writeFileSync(
      path.join(workspaceRoot, '.forge', 'config.yaml'),
      'models: [unclosed\n',
      'utf8',
    );
    mocks.workspaceFolders.push({ uri: { fsPath: workspaceRoot } });

    bootstrapConfig(
      fakeContext() as unknown as Parameters<typeof bootstrapConfig>[0],
      statusBar(),
      mkTempDir('forge-bootstrap-storage-'),
    );

    expect(mocks.warnings.join('\n')).not.toContain('Reload the window');
  });

  /**
   * BL-026: a config the loader refuses stops activation here, and
   * `extension.ts:87` returns before `registerActivationCommands` at `:307`, so
   * `forge.movePolicy` — the command this window's own error message tells the
   * owner to run — sat in the palette with no handler. The advice was a dead end,
   * and the only way out was to hand-edit the YAML the command exists to move.
   */
  it('registers the command its own error message names, on the path it tried', async () => {
    const workspaceRoot = mkTempDir('forge-bootstrap-deadend-');
    fs.mkdirSync(path.join(workspaceRoot, '.forge'));
    fs.writeFileSync(
      path.join(workspaceRoot, '.forge', 'config.yaml'),
      'models: [unclosed\n',
      'utf8',
    );
    mocks.workspaceFolders.push({ uri: { fsPath: workspaceRoot } });
    const context = fakeContext();

    const bootstrapped = bootstrapConfig(
      context as unknown as Parameters<typeof bootstrapConfig>[0],
      statusBar(),
      mkTempDir('forge-bootstrap-storage-'),
    );

    expect(bootstrapped).toBeUndefined();
    const recovery = mocks.registered.find((entry) => entry.id === 'forge.movePolicy');
    expect(recovery).toBeDefined();
    // Its cleanup goes in too: `context.subscriptions` is how a window releases a
    // command registered outside `registerActivationCommands`.
    expect(context.subscriptions.length).toBeGreaterThan(0);

    await recovery?.run();
    // The path `bootstrapConfig` actually tried, not a fresh lookup that could
    // land on a different layer of the pair.
    expect(mocks.runMigration).toHaveBeenCalledWith(
      path.join(workspaceRoot, '.forge', 'config.yaml'),
    );
    expect(mocks.information.mock.calls[0]?.[0]).toContain('Backup');
  });

  it('names the path it did fall back to when one exists', () => {
    const workspaceRoot = workspaceWithConfig();
    // A folder that holds no config.yaml: the other half of the same mistake.
    mocks.configFile = mkTempDir('forge-bootstrap-empty-dir-');

    const bootstrapped = bootstrapConfig(
      fakeContext() as unknown as Parameters<typeof bootstrapConfig>[0],
      statusBar(),
      mkTempDir('forge-bootstrap-storage-'),
    );

    const used = path.join(workspaceRoot, '.forge', 'config.yaml');
    expect(bootstrapped?.configPath).toBe(used);
    expect(mocks.enterSetupMode).not.toHaveBeenCalled();
    expect(mocks.warnings).toHaveLength(1);
    expect(mocks.warnings[0]).toContain('Using ');
    expect(mocks.warnings[0]).toContain(used);
    expect(mocks.warnings[0]).toContain(' instead.');
  });

  it('says nothing when there is no setting to complain about', async () => {
    const workspaceRoot = workspaceWithConfig();
    const storagePath = mkTempDir('forge-bootstrap-storage-');
    for (const unset of [undefined, '', '   ']) {
      mocks.warnings.length = 0;
      mocks.configFile = unset;
      const bootstrapped = bootstrapConfig(
        fakeContext() as unknown as Parameters<typeof bootstrapConfig>[0],
        statusBar(),
        storagePath,
      );
      expect(bootstrapped?.configPath).toBe(path.join(workspaceRoot, '.forge', 'config.yaml'));
      expect(mocks.warnings).toEqual([]);
    }
  });

  it('uses a setting that does resolve, without warning', () => {
    const dir = mkTempDir('forge-bootstrap-explicit-');
    fs.writeFileSync(path.join(dir, 'config.yaml'), VALID_CONFIG, 'utf8');
    mocks.configFile = dir;

    const bootstrapped = bootstrapConfig(
      fakeContext() as unknown as Parameters<typeof bootstrapConfig>[0],
      statusBar(),
      mkTempDir('forge-bootstrap-storage-'),
    );

    // The folder form still resolves, and a warning on it would be a false alarm.
    expect(bootstrapped?.configPath).toBe(path.join(dir, 'config.yaml'));
    expect(mocks.warnings).toEqual([]);
  });
});
