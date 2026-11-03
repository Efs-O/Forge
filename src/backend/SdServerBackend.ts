import { type ChildProcess } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SdcppImageBackendConfig } from '../config/types';
import { touchAdoptedSdServerRecord } from './sdServerAdoption';
import { composeSdServerArgs, sdServerBaseUrl, sdServerSignature } from './sdServerArgs';
import { spawnLlamaServer, killLlamaProcess } from './llamaProcess';
import { createSdServerRecord, reconcileSdServerRecord } from './sdServerReconciliation';
import {
  createSdServerIdleStopPolicy,
  startSdServerOrphanMonitor,
  type SdServerIdleStopPolicy,
} from './sdServerIdle';
import { verifyConfiguredPaths } from './sdServerPaths';
import { isConnectionRefused, SdServerReadiness } from './sdServerReadiness';
import { acquireMediaGpuLease, type MediaGpuLeaseHandle } from '../media/mediaGpuLease';
import {
  deleteSdServerRecord,
  lookupWindowsProcess,
  readSdServerRecord,
  sameServer,
  sdServerRecordPath,
  terminateWindowsProcessTree,
  writeSdServerRecord,
  type SdProcessIdentity,
  type SdServerOwnerRecord,
} from './sdServerOwnerRecord';

export { composeSdServerArgs, sdServerSignature } from './sdServerArgs';

export interface SdStartOptions {
  /**
   * Runs once per start, after reconciliation, and only when this window is
   * about to spawn its own server — never for an adopted one. That is where the
   * VRAM gate belongs: the owner gated when it spawned, and gating an adopter
   * would refuse the very VRAM the owned server is holding.
   */
  beforeSpawn?: () => Promise<void>;
}

export interface SdServerBackendDeps {
  spawn?: typeof spawnLlamaServer;
  fetch?: typeof fetch;
  lookupProcess?: (pid: number) => Promise<SdProcessIdentity | undefined>;
  terminateProcess?: (pid: number) => Promise<void>;
  killProcess?: (proc: ChildProcess) => Promise<void>;
  now?: () => number;
  recordDir?: string;
  ownerPid?: number;
  acquireMediaGpuLease?: typeof acquireMediaGpuLease;
}

export class SdServerBackend {
  private readonly spawn: typeof spawnLlamaServer;
  private readonly fetchImpl: typeof fetch;
  private readonly lookupProcess: (pid: number) => Promise<SdProcessIdentity | undefined>;
  private readonly terminateProcess: (pid: number) => Promise<void>;
  private readonly killProcess: (proc: ChildProcess) => Promise<void>;
  private readonly now: () => number;
  private readonly ownerPid: number;
  private readonly acquireMediaLease: typeof acquireMediaGpuLease;
  private proc: ChildProcess | null = null;
  private ready = false;
  private adopted = false;
  private disposed = false;
  private startPromise: Promise<void> | null = null;
  private startAbort: AbortController | null = null;
  private readonly idlePolicy: SdServerIdleStopPolicy;
  private readonly orphanMonitor: { dispose: () => void };
  private record: SdServerOwnerRecord | null = null;
  private mediaLease: MediaGpuLeaseHandle | null = null;
  private output: vscode.OutputChannel | null = null;
  private readonly recordPath: string;

  constructor(
    readonly config: SdcppImageBackendConfig,
    deps: SdServerBackendDeps = {},
  ) {
    this.spawn = deps.spawn ?? spawnLlamaServer;
    this.fetchImpl = deps.fetch ?? fetch;
    this.lookupProcess = deps.lookupProcess ?? lookupWindowsProcess;
    this.terminateProcess = deps.terminateProcess ?? terminateWindowsProcessTree;
    this.killProcess = deps.killProcess ?? killLlamaProcess;
    this.now = deps.now ?? Date.now;
    this.ownerPid = deps.ownerPid ?? process.pid;
    this.acquireMediaLease = deps.acquireMediaGpuLease ?? acquireMediaGpuLease;
    const directory =
      deps.recordDir ??
      (process.env['LOCALAPPDATA']
        ? path.join(process.env['LOCALAPPDATA'], 'Forge', 'sdcpp')
        : undefined);
    if (!directory) {
      throw new Error(
        'sdcpp owner record requires LOCALAPPDATA; set it before starting this backend.',
      );
    }
    this.recordPath = sdServerRecordPath(directory, config.name);
    this.orphanMonitor = startSdServerOrphanMonitor({
      config,
      recordPath: this.recordPath,
      fetchImpl: this.fetchImpl,
      lookupProcess: this.lookupProcess,
      terminateProcess: this.terminateProcess,
      now: this.now,
    });
    this.idlePolicy = createSdServerIdleStopPolicy({
      idleTimeoutMs: config.idle_timeout_ms,
      recordPath: this.recordPath,
      now: this.now,
      facts: () => ({
        ownsProcess: Boolean(this.proc) && !this.adopted,
        ready: this.ready,
        disposed: this.disposed,
      }),
      readCurrentRecord: () =>
        readSdServerRecord(this.recordPath, (message) => this.output?.appendLine(message)),
      ownedRecord: () => this.record,
      stopOwnedProcess: () => this.stopOwnedProcess(),
      log: (line) => this.output?.appendLine(line),
    });
  }

  baseUrl(): string {
    return sdServerBaseUrl(this.config);
  }

  /** Approval copy for the caller that wires this backend in Phase 2. */
  startApproval(): { detail: string } | undefined {
    if (this.config.confirm_on_start && !this.ready && !this.startPromise && !this.disposed) {
      return {
        detail:
          `Start ${this.config.name} (${path.basename(this.config.diffusion_model)}) on CUDA device ` +
          `${this.config.cuda_device}; it requires ${Math.ceil(this.config.min_free_vram_mb / 1024)} GB ` +
          `free VRAM and Forge stops it after ${Math.ceil(this.config.idle_timeout_ms / 60_000)} minutes idle.`,
      };
    }
    return undefined;
  }

  async start(options: SdStartOptions = {}): Promise<void> {
    if (this.disposed) throw new Error(`sdcpp backend "${this.config.name}" has been disposed.`);
    // An adopted server belongs to another window, which may have idled it out
    // or died since: re-reconcile against the owner record before every use,
    // so this window re-adopts, spawns its own, or reaps — never a stale "ready".
    if (this.ready && this.adopted && !this.startPromise) {
      this.ready = false;
      this.adopted = false;
      this.record = null;
    }
    if (this.ready) return;
    if (this.startPromise) return this.startPromise;
    const startPromise = this.startInternal(options);
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  async withActivity<T>(operation: () => Promise<T>, options: SdStartOptions = {}): Promise<T> {
    this.idlePolicy.useStarted();
    try {
      await this.start(options);
      if (this.adopted) {
        this.record = await touchAdoptedSdServerRecord(
          this.recordPath,
          this.config,
          this.record,
          this.now,
          (message) => this.output?.appendLine(message),
        );
      }
      return await operation();
    } finally {
      try {
        if (this.adopted) {
          this.record = await touchAdoptedSdServerRecord(
            this.recordPath,
            this.config,
            this.record,
            this.now,
            (message) => this.output?.appendLine(message),
          );
        }
      } catch (error) {
        // Throwing here would replace a finished render with this error. The
        // next start() re-reconciles the record, so report it and move on.
        this.output?.appendLine(
          `[Forge] Could not record last use on the adopted sd-server: ${errorMessage(error)}`,
        );
      } finally {
        this.idlePolicy.useFinished();
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.idlePolicy.clear();
    this.orphanMonitor.dispose();
    this.startAbort?.abort();
    this.startAbort = null;
    try {
      if (this.startPromise) await this.startPromise;
      if (this.proc && !this.adopted) await this.stopOwnedProcess();
    } finally {
      this.output?.dispose();
      this.output = null;
    }
  }

  /**
   * The plan's abort rule. Phase 0b measured that dropping the HTTP connection
   * does not cancel a render (`cancel_generating: false`), so an aborted turn
   * leaves the card busy until the owned server is killed. An adopted server is
   * never stopped, and an owned one only when `record.lastUsedAt` is older than
   * `request_timeout_ms` — the only cross-window evidence that no other window
   * has a render in flight. Returns the sentence the tool reports back.
   */
  async stopAfterAbort(): Promise<string> {
    this.idlePolicy.clear();
    const idleMinutes = Math.ceil(this.config.idle_timeout_ms / 60_000);
    if (this.adopted) {
      return (
        `The sd-server on port ${this.config.port} belongs to another Forge window, so Forge left it ` +
        `running: its render continues and that window stops it after ${idleMinutes} minutes idle.`
      );
    }
    if (!this.proc) {
      return 'Forge no longer owns an sd-server, so the GPU is already free.';
    }
    const record = await readSdServerRecord(this.recordPath, (message) =>
      this.output?.appendLine(message),
    );
    // No record means no adopter could have reached this server at all, so
    // nothing but this window can be rendering on it.
    if (record && this.now() - record.lastUsedAt < this.config.request_timeout_ms) {
      const quietMinutes = Math.ceil(this.config.request_timeout_ms / 60_000);
      return (
        `Another window used this sd-server within the last ${quietMinutes} minute(s), so Forge left it ` +
        `running rather than cut across a possible render; it stops after ${idleMinutes} minutes idle.`
      );
    }
    await this.stopOwnedProcess();
    return 'Forge stopped its own sd-server, the only way to cancel a render, so the card is free again.';
  }

  private async startInternal(options: SdStartOptions): Promise<void> {
    await verifyConfiguredPaths(this.config);
    this.output ??= vscode.window.createOutputChannel('Forge - image server');
    const readiness = new SdServerReadiness(
      this.fetchImpl,
      `${this.baseUrl()}/sdcpp/v1/capabilities`,
      this.output,
      this.now,
    );
    const signature = sdServerSignature(this.config);
    const existing = await readSdServerRecord(this.recordPath, (message) =>
      this.output?.appendLine(message),
    );
    if (existing && (await this.reconcileExisting(existing, signature))) return;

    let portAnswers = false;
    try {
      portAnswers = (await readiness.probe()).answers;
    } catch (error) {
      if (!isConnectionRefused(error)) {
        throw new Error(
          `Could not probe sdcpp port ${this.config.port}: ${errorMessage(error)}. ` +
            'Check that the configured port is available.',
        );
      }
    }
    if (portAnswers) {
      throw new Error(
        `sdcpp backend "${this.config.name}": port ${this.config.port} answers but has no verifiable ` +
          `Forge owner record. Stop that process manually or choose another port.`,
      );
    }

    await options.beforeSpawn?.();
    if (this.config.media_gpu_lease_enabled) {
      this.mediaLease = await this.acquireMediaLease(
        `sd-server:${this.config.name}`,
        this.config.cuda_device,
      );
    }
    const args = composeSdServerArgs(this.config);
    const binary = this.config.binary;
    const processEnv = {
      ...process.env,
      CUDA_DEVICE_ORDER: 'PCI_BUS_ID',
      CUDA_VISIBLE_DEVICES: String(this.config.cuda_device),
    };
    this.output.appendLine(`> ${binary} ${args.join(' ')}`);
    this.output.appendLine('');
    const startAbort = new AbortController();
    this.startAbort = startAbort;
    let child: ChildProcess;
    try {
      child = this.spawn(binary, args, processEnv);
    } catch (error) {
      this.startAbort = null;
      await this.releaseMediaLease();
      throw new Error(
        `image_generation.backends.${this.config.name}.binary "${binary}" could not be started: ` +
          `${errorMessage(error)}. Verify the executable path and its Windows dependencies.`,
      );
    }
    this.proc = child;
    readiness.attach(child);
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      void this.handleProcessExit(child, code, signal).catch((error: unknown) => {
        this.output?.appendLine(
          `[Forge] Could not reconcile exited sd-server: ${errorMessage(error)}`,
        );
      });
    });

    try {
      this.record = await createSdServerRecord(this.config, child, binary, signature, {
        lookupProcess: this.lookupProcess,
        now: this.now,
        ownerPid: this.ownerPid,
      });
      // The lease must name the server, not this window: a force-killed window
      // leaves this child running with its VRAM, and a lease naming a dead pid
      // reads as stale to every other taker, which then renders on a busy GPU.
      // A failed transfer is fatal here, through the catch below: the child is
      // stopped and the lease released, never a silent fallback to a stale lease.
      const mediaLease = this.mediaLease;
      if (mediaLease) await mediaLease.transfer(this.record.pid, this.record.pidCreatedAt);
      await writeSdServerRecord(this.recordPath, this.record);
      await readiness.waitUntilReady(child, startAbort.signal);
      this.ready = true;
      this.adopted = false;
      this.idlePolicy.schedule();
    } catch (error) {
      const failure = new Error(
        `image_generation.backends.${this.config.name}.binary "${binary}": ` +
          readiness.startFailure(error).message,
      );
      try {
        await this.stopOwnedProcess();
      } catch (cleanupError) {
        throw new AggregateError(
          [failure, cleanupError],
          `sdcpp backend "${this.config.name}" failed startup and cleanup.`,
        );
      }
      throw failure;
    } finally {
      this.startAbort = null;
    }
  }

  /**
   * The identity decision lives in `sdServerReconciliation.ts`; this only turns
   * its answer into this instance's state.
   */
  private async reconcileExisting(
    record: SdServerOwnerRecord,
    signature: string,
  ): Promise<boolean> {
    const adopted = await reconcileSdServerRecord(this.config, record, signature, {
      lookupProcess: this.lookupProcess,
      now: this.now,
      terminateProcess: this.terminateProcess,
      fetchImpl: this.fetchImpl,
      recordPath: this.recordPath,
      baseUrl: this.baseUrl(),
    });
    if (!adopted) return false;
    this.record = adopted;
    this.ready = true;
    this.adopted = true;
    this.output?.appendLine(
      `[Forge] Adopted ${this.config.name} sd-server on port ${this.config.port}.`,
    );
    return true;
  }

  private async stopOwnedProcess(): Promise<void> {
    this.idlePolicy.clear();
    this.startAbort?.abort();
    this.startAbort = null;
    const child = this.proc;
    if (!child || this.adopted) return;
    this.proc = null;
    const wasReady = this.ready;
    this.ready = false;
    try {
      await this.killProcess(child);
    } catch (error) {
      this.proc = child;
      this.ready = wasReady;
      throw error;
    }
    try {
      const ownedRecord = this.record;
      this.record = null;
      const currentRecord = await readSdServerRecord(this.recordPath, (message) =>
        this.output?.appendLine(message),
      );
      if (currentRecord && ownedRecord && !sameServer(currentRecord, ownedRecord)) {
        throw new Error(
          `sd-server stopped, but owner record "${this.recordPath}" now describes another process; ` +
            'that record was preserved.',
        );
      }
      if (currentRecord) await deleteSdServerRecord(this.recordPath);
    } finally {
      await this.releaseMediaLease();
    }
  }

  private async handleProcessExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (this.proc !== child || this.adopted) return;
    this.proc = null;
    this.ready = false;
    this.idlePolicy.clear();
    const exitedRecord = this.record;
    this.record = null;
    this.output?.appendLine(
      `[Forge] sd-server exited (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}); ` +
        'the next activity will attempt a restart.',
    );
    try {
      await this.releaseMediaLease();
    } finally {
      await this.cleanupExitedRecord(exitedRecord);
    }
  }

  private async cleanupExitedRecord(exitedRecord: SdServerOwnerRecord | null): Promise<void> {
    if (!exitedRecord) return;
    const current = await readSdServerRecord(this.recordPath, (message) =>
      this.output?.appendLine(message),
    );
    if (!current) return;
    if (!sameServer(current, exitedRecord)) {
      throw new Error(
        `owner record "${this.recordPath}" now describes another process and was preserved.`,
      );
    }
    await deleteSdServerRecord(this.recordPath);
  }

  private async releaseMediaLease(): Promise<void> {
    const lease = this.mediaLease;
    if (!lease) return;
    try {
      await lease.release();
      this.mediaLease = null;
    } catch (error) {
      this.output?.appendLine(`[Forge] Could not release media GPU lease: ${errorMessage(error)}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
