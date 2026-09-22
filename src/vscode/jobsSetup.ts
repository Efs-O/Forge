import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { findConfigPath } from '../config/ConfigLoader';
import type { ForgeConfig } from '../config/types';
import { JobStore } from '../jobs/JobStore';
import { JobScheduler } from '../jobs/JobScheduler';
import type { IBackendPool } from '../backend/poolTypes';
import { clearWakesIfUnowned } from '../jobs/schedulerWakes';
import { PowerControl } from '../system/PowerControl';
import type { SidebarProvider } from '../sidebar/SidebarProvider';
import { forgeLocalRoot } from '../jobs/actions/stagedBuild';
import { extractZip, makeSetBinary, runCommand, sha256File } from '../jobs/actions/llamacppIo';

/**
 * Wires the persistent agent jobs scheduler (B1). All the wiring lives here
 * rather than in `extension.ts` (which is at its 500-line hard stop): one call
 * in activation, one line in the config-reload handler, one subscription.
 *
 * Without `jobs.enabled` there is no scheduler tick. The small setup object
 * still exists so activation and reload can remove a stale recurring wake task
 * left by an earlier enabled configuration — but only when no live window holds
 * the scheduler lease, because the task is machine-wide and that window's.
 *
 * The scheduler runs in whichever window wins the `jobs-scheduler` lease. The
 * other enabled windows tick passively, retrying the lease, and take over when
 * the owner's window closes; their `manage_jobs` tool edits the same job files,
 * and the lease holder picks up the change through the store watch.
 */

export interface JobsSetup {
  /** The shared job store, so the `manage_jobs` tool edits the same files the scheduler watches. */
  readonly store: JobStore;
  /** Reconcile the recurring wake task after a config reload. */
  onConfigReloaded(): void;
  dispose(): void;
}

/**
 * Set up wake reconciliation and start the scheduler when `jobs.enabled`.
 */
export function setupJobs(
  context: vscode.ExtensionContext,
  getConfig: () => ForgeConfig,
  workspaceId: string,
  sidebar: SidebarProvider,
  store: JobStore = new JobStore(),
  pool?: IBackendPool,
): JobsSetup {
  // The config path the `llamacpp_update` action switches. Derived the same
  // way `extension.ts` derives it (workspace `.forge/`, then global storage),
  // so the action stays wired without a 6th arg that would push `extension.ts`
  // past its 500-line stop. `setupJobs` runs only after activation found a
  // config, so this resolves to the same path.
  const configPath = findConfigPath(
    context.globalStorageUri.fsPath,
    vscode.workspace.getConfiguration('forge').get<string>('configFile'),
  );
  // One owner of the power spawn sites, shared with the tool and the remote
  // commands: PowerControl is stateless, so a second instance would be a
  // second owner of the same `schtasks`/`powercfg` sites.
  const power = new PowerControl();
  const instanceId = randomUUID();

  const makeScheduler = (): JobScheduler =>
    new JobScheduler({
      store,
      power,
      getConfig: () => {
        const jobs = getConfig().jobs;
        return {
          allowedHosts: jobs?.allowed_hosts ?? [],
          maxConcurrent: jobs?.max_concurrent ?? 2,
        };
      },
      workspaceId,
      instanceId,
      leaseDirectory: store.root,
      notifyLocal: (message) => void vscode.window.showInformationMessage(message),
      busy: () => {
        // A turn streaming anywhere means the GPU is busy: a summarize must not
        // compete with a live chat, and sleep_if_idle must not suspend a box the
        // user is actively using.
        const { streamingConversationIds } = sidebar.getHostFacade().status();
        return streamingConversationIds.length > 0 ? 'a turn is streaming' : undefined;
      },
      summarize: async (prompt) => sidebar.runPromptToMarkdown(prompt),
      // The agent-task runner (AGENT_TASK_JOBS_PLAN phase 3). Wired whenever a
      // host facade is available; the runner records a failed run when the
      // backend pool is absent. The config path is optional: without it the
      // step-7 rollback simply has nothing to restore.
      agentTask: {
        store,
        power,
        host: () => sidebar.getHostFacade(),
        pool: () => pool,
        defaultModel: () => getConfig().active_model ?? undefined,
        outboxDir: store.outboxDir,
        notifyLocal: (message) => void vscode.window.showInformationMessage(message),
        busy: () => {
          const { streamingConversationIds } = sidebar.getHostFacade().status();
          return streamingConversationIds.length > 0 ? 'a turn is streaming' : undefined;
        },
        now: () => Date.now(),
        ...(configPath ? { configPath } : {}),
      },
      // The only mutating action (B5). Wired only when a config path is known:
      // without it there is no `llama_server.binary` to switch, so a
      // llamacpp_update job records the change but does not mutate the machine.
      ...(configPath
        ? {
            llamacpp: {
              localRoot: forgeLocalRoot(),
              getLlamacppConfig: () => {
                const c = getConfig();
                return {
                  currentBinary: c.llama_server?.binary,
                  embeddings: c.embeddings,
                  llama_server: c.llama_server,
                };
              },
              runCommand,
              sha256File,
              extractZip,
              setBinary: makeSetBinary(configPath),
              restartModel: (modelName) => sidebar.restartModel(modelName),
              activeModel: () => getConfig().active_model ?? undefined,
            },
          }
        : {}),
    });

  let started = false;
  let scheduler: JobScheduler | undefined;
  const startIfEnabled = (): void => {
    if (started || getConfig().jobs?.enabled !== true) return;
    started = true;
    const instance = makeScheduler();
    scheduler = instance;
    // Watch whether or not this window won the lease: the reconcile is a
    // no-op without it, and a non-owner that takes over later must not need
    // a second install.
    instance.watch();
    void instance.start().catch((err) => {
      started = false;
      void vscode.window.showErrorMessage(
        `Forge jobs scheduler failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };
  // Jobs off here: remove a stale wake task, unless a live window owns it.
  const clearStaleWakes = (): Promise<void> =>
    process.platform !== 'win32'
      ? Promise.resolve()
      : clearWakesIfUnowned({ power, directory: store.root, workspaceId, instanceId })
          .then(() => undefined)
          .catch((err: Error) => {
            void vscode.window.showErrorMessage(
              `Forge jobs: could not remove the scheduled wake task: ${err.message}`,
            );
          });
  if (getConfig().jobs?.enabled === true) startIfEnabled();
  else void clearStaleWakes();

  const setup: JobsSetup = {
    store,
    onConfigReloaded: () => {
      // A reload can disable jobs (delete the task) or change the schedule
      // (re-register it). Reconcile either way; a no-op when there is no lease.
      if (getConfig().jobs?.enabled !== true) {
        const stopping = scheduler?.stop() ?? Promise.resolve();
        if (scheduler) {
          scheduler = undefined;
          started = false;
          // The store watch was installed by the scheduler that just stopped;
          // leaving it running would keep an fs.watch alive against a disposed
          // scheduler until the window closes.
          store.unwatch();
        }
        // After our own lease is released, so an owner can clear its task.
        void stopping.then(clearStaleWakes, (err: Error) => {
          void vscode.window.showErrorMessage(
            `Forge jobs scheduler did not stop cleanly: ${err.message}`,
          );
        });
        return;
      }
      startIfEnabled();
      void scheduler?.reconcileWakes();
    },
    dispose: () => {
      store.unwatch();
      void scheduler?.stop();
    },
  };
  context.subscriptions.push(setup);
  return setup;
}
