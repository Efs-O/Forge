import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobsConfigSchema } from '../../src/config/jobsSchema';
import type { ForgeConfig } from '../../src/config/types';
import { JobStore } from '../../src/jobs/JobStore';
import { workspaceIdFor } from '../../src/remote/RemoteWorkspaceHandoff';
import type { SidebarProvider } from '../../src/sidebar/SidebarProvider';
import { setupJobs, type JobsSetup } from '../../src/vscode/jobsSetup';

const mocks = vi.hoisted(() => ({
  acquireSchedulerLease: vi.fn(async () => undefined),
  clearWakesIfUnowned: vi.fn(async () => false),
  appendLine: vi.fn(),
  getConfigSetting: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
}));

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: mocks.getConfigSetting }) },
  window: {
    createOutputChannel: () => ({ appendLine: mocks.appendLine, show: vi.fn(), dispose: vi.fn() }),
    showErrorMessage: mocks.showErrorMessage,
    showInformationMessage: mocks.showInformationMessage,
  },
}));

vi.mock('../../src/config/ConfigLoader', () => ({ findConfigPath: () => undefined }));
vi.mock('../../src/jobs/jobLease', () => ({ acquireSchedulerLease: mocks.acquireSchedulerLease }));
vi.mock('../../src/jobs/schedulerWakes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/jobs/schedulerWakes')>();
  return { ...actual, clearWakesIfUnowned: mocks.clearWakesIfUnowned };
});

let root: string;
let store: JobStore;
let setups: JobsSetup[];

function config(homeWorkspace: string, enabled = true): ForgeConfig {
  return { jobs: JobsConfigSchema.parse({ enabled, home_workspace: homeWorkspace }) } as ForgeConfig;
}

function setup(configRef: { current: ForgeConfig }, workspaceId: string): JobsSetup {
  const context = {
    globalStorageUri: { fsPath: root },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
  const result = setupJobs(
    context,
    () => configRef.current,
    workspaceId,
    {} as SidebarProvider,
    store,
  );
  setups.push(result);
  return result;
}

async function waitForLeaseAttempts(count: number): Promise<void> {
  await vi.waitFor(() => expect(mocks.acquireSchedulerLease).toHaveBeenCalledTimes(count));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-jobs-setup-'));
  store = new JobStore(root);
  setups = [];
  mocks.acquireSchedulerLease.mockReset().mockResolvedValue(undefined);
  mocks.clearWakesIfUnowned.mockReset().mockResolvedValue(false);
  mocks.appendLine.mockClear();
  mocks.getConfigSetting.mockReset().mockReturnValue(undefined);
  mocks.showErrorMessage.mockReset();
  mocks.showInformationMessage.mockReset();
});

afterEach(async () => {
  for (const result of setups) result.dispose();
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('jobs home-window scheduler gate', () => {
  it('does not acquire a lease, clear wakes, or watch the store in a non-home window', () => {
    const home = path.resolve('forge-home');
    const current = { current: config(home) };
    const watch = vi.spyOn(store, 'watch');
    const result = setup(current, workspaceIdFor(path.resolve('other-workspace')));

    result.onConfigReloaded();
    result.onConfigReloaded();

    expect(mocks.acquireSchedulerLease).not.toHaveBeenCalled();
    expect(mocks.clearWakesIfUnowned).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
    const homeLogs = mocks.appendLine.mock.calls.filter(([line]) =>
      String(line).includes('jobs run in the window for'),
    );
    expect(homeLogs).toHaveLength(1);
  });

  it('stops and unwatches on home-to-non-home reload without clearing wakes', async () => {
    const home = path.resolve('forge-home');
    const current = { current: config(home) };
    vi.spyOn(store, 'watch');
    const unwatch = vi.spyOn(store, 'unwatch');
    const result = setup(current, workspaceIdFor(home));

    await waitForLeaseAttempts(1);
    expect(store.watch).toHaveBeenCalledTimes(1);
    current.current = config(path.resolve('other-workspace'));
    result.onConfigReloaded();

    expect(unwatch).toHaveBeenCalledTimes(1);
    expect(mocks.acquireSchedulerLease).toHaveBeenCalledTimes(1);
    expect(mocks.clearWakesIfUnowned).not.toHaveBeenCalled();
  });

  it('starts the scheduler when a non-home window reloads as home', async () => {
    const home = path.resolve('forge-home');
    const current = { current: config(path.resolve('other-workspace')) };
    vi.spyOn(store, 'watch');
    const result = setup(current, workspaceIdFor(home));

    expect(mocks.acquireSchedulerLease).not.toHaveBeenCalled();
    current.current = config(home);
    result.onConfigReloaded();
    await waitForLeaseAttempts(1);

    expect(store.watch).toHaveBeenCalledTimes(1);
    expect(mocks.clearWakesIfUnowned).not.toHaveBeenCalled();
  });
});
