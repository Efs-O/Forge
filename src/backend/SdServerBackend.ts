import { type ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SdcppImageBackendConfig } from '../config/types';
import { touchAdoptedSdServerRecord, verifySdServerAdoption } from './sdServerAdoption';
import { composeSdServerArgs, sdServerSignature } from './sdServerArgs';
import { spawnLlamaServer, killLlamaProcess } from './llamaProcess';
import { isConnectionRefused, SdServerReadiness } from './sdServerReadiness';
import {
  deleteSdServerRecord,
  lookupWindowsProcess,
  readSdServerRecord,
  sameExecutablePath,
  sameProcessCreation,
  sdServerRecordPath,
  terminateWindowsProcessTree,
  waitForSdProcessExit,
  writeSdServerRecord,
  type SdProcessIdentity,
  type SdServerOwnerRecord,
} from './sdServerOwnerRecord';

export { composeSdServerArgs } from './sdServerArgs';

export interface SdServerBackendDeps {
  spawn?: typeof spawnLlamaServer;
  fetch?: typeof fetch;
  lookupProcess?: (pid: number) => Promise<SdProcessIdentity | undefined>;
  terminateProcess?: (pid: number) => Promise<void>;
  killProcess?: (proc: ChildProcess) => Promise<void>;
  now?: () => number;
  recordDir?: string;
  ownerPid?: number;
}

export class SdServerBackend {
  private readonly spawn: typeof spawnLlamaServer;
  private readonly fetchImpl: typeof fetch;
  private readonly lookupProcess: (pid: number) => Promise<SdProcessIdentity | undefined>;
  private readonly terminateProcess: (pid: number) => Promise<void>;
  private readonly killProcess: (proc: ChildProcess) => Promise<void>;
  private readonly now: () => number;
  private readonly ownerPid: number;
  private proc: ChildProcess | null = null;
  private ready = false;
  private adopted = false;
  private disposed = false;
  private startPromise: Promise<void> | null = null;
  private startAbort: AbortController | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeUses = 0;
  private lastLocalUseAt = 0;
  private record: SdServerOwnerRecord | null = null;
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
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.config.port}`;
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

  async start(): Promise<void> {
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
    const startPromise = this.startInternal();
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  async withActivity<T>(operation: () => Promise<T>): Promise<T> {
    this.activeUses++;
    this.lastLocalUseAt = this.now();
    this.clearIdleTimer();
    try {
      await this.start();
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
        this.lastLocalUseAt = this.now();
        this.activeUses--;
        this.scheduleIdleStop();
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdleTimer();
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

  private async startInternal(): Promise<void> {
    await this.verifyConfiguredPaths();
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
      const pid = child.pid;
      if (!pid) throw new Error('sd-server spawn returned no pid.');
      const [serverIdentity, ownerIdentity] = await Promise.all([
        this.lookupProcess(pid),
        this.lookupProcess(this.ownerPid),
      ]);
      if (!serverIdentity)
        throw new Error(`Get-CimInstance did not find spawned sd-server pid ${pid}.`);
      if (!sameExecutablePath(serverIdentity.executablePath, binary)) {
        throw new Error(
          `Spawned sd-server pid ${pid} resolves to "${serverIdentity.executablePath}", not binary "${binary}".`,
        );
      }
      if (!ownerIdentity) {
        throw new Error(
          `Get-CimInstance did not return creation time for Forge owner pid ${this.ownerPid}.`,
        );
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`sd-server exited before its owner record could be written (pid ${pid}).`);
      }
      const timestamp = this.now();
      this.record = {
        pid,
        pidCreatedAt: serverIdentity.createdAt,
        port: this.config.port,
        binary,
        diffusionModel: this.config.diffusion_model,
        signature,
        ownerPid: this.ownerPid,
        ownerCreatedAt: ownerIdentity.createdAt,
        startedAt: timestamp,
        lastUsedAt: timestamp,
      };
      await writeSdServerRecord(this.recordPath, this.record);
      await readiness.waitUntilReady(child, startAbort.signal);
      this.ready = true;
      this.adopted = false;
      this.scheduleIdleStop();
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

  private async reconcileExisting(
    record: SdServerOwnerRecord,
    signature: string,
  ): Promise<boolean> {
    const [ownerIdentity, serverIdentity] = await Promise.all([
      this.lookupProcess(record.ownerPid),
      this.lookupProcess(record.pid),
    ]);
    const ownerAlive = sameProcessCreation(ownerIdentity, record.ownerCreatedAt);
    const serverAlive = sameProcessCreation(serverIdentity, record.pidCreatedAt);
    if (!serverAlive) {
      await deleteSdServerRecord(this.recordPath);
      return false;
    }
    if (!serverIdentity) {
      throw new Error(`Get-CimInstance omitted identity for sd-server pid ${record.pid}.`);
    }
    if (!ownerAlive && serverAlive) {
      const activeUntil = record.lastUsedAt + this.config.idle_timeout_ms;
      if (activeUntil > this.now()) {
        throw new Error(
          `sdcpp port ${record.port} is held by recently used pid ${record.pid}; ` +
            `Forge will not interrupt its possible in-flight request. Retry after ${new Date(activeUntil).toISOString()}.`,
        );
      }
      if (!sameExecutablePath(serverIdentity.executablePath, this.config.binary)) {
        throw new Error(
          `sdcpp port ${record.port} is held by pid ${record.pid}, whose executable ` +
            `"${serverIdentity.executablePath}" does not match configured binary "${this.config.binary}". ` +
            'Forge will not kill an unverified process; stop it manually or choose another port.',
        );
      }
      await this.terminateProcess(record.pid);
      await waitForSdProcessExit(this.lookupProcess, record.pid, record.pidCreatedAt, this.now);
      await deleteSdServerRecord(this.recordPath);
      return false;
    }
    if (ownerAlive && record.signature !== signature) {
      throw new Error(
        `sdcpp port ${record.port} is owned by another Forge window using model ` +
          `"${record.diffusionModel}". Stop that backend or configure another port/model.`,
      );
    }
    if (!ownerAlive) {
      throw new Error(
        `sdcpp port ${record.port} is held by pid ${record.pid}, but its owner/process identity ` +
          'cannot be verified. Stop it manually or choose another port.',
      );
    }
    if (!sameExecutablePath(serverIdentity.executablePath, this.config.binary)) {
      throw new Error(
        `sdcpp owner record for port ${record.port} names pid ${record.pid} at ` +
          `"${serverIdentity.executablePath}", not configured binary "${this.config.binary}".`,
      );
    }
    await verifySdServerAdoption(this.config, this.baseUrl(), this.fetchImpl);
    this.record = record;
    this.ready = true;
    this.adopted = true;
    this.output?.appendLine(
      `[Forge] Adopted ${this.config.name} sd-server on port ${this.config.port}.`,
    );
    return true;
  }

  private async verifyConfiguredPaths(): Promise<void> {
    const entries = [
      ['binary', this.config.binary],
      ['diffusion_model', this.config.diffusion_model],
      ['text_encoder', this.config.text_encoder],
      ['vae', this.config.vae],
    ] as const;
    for (const [key, configuredPath] of entries) {
      try {
        await fs.access(configuredPath);
      } catch (error) {
        throw new Error(
          `image_generation.backends.${this.config.name}.${key}: configured path ` +
            `"${configuredPath}" is unavailable (${error instanceof Error ? error.message : String(error)}); ` +
            'correct this path in config.yaml or install the configured file.',
        );
      }
    }
  }

  private scheduleIdleStop(): void {
    this.clearIdleTimer();
    if (!this.proc || this.adopted || !this.ready || this.activeUses > 0 || this.disposed) return;
    if (this.lastLocalUseAt === 0) this.lastLocalUseAt = this.now();
    const localDeadline = this.lastLocalUseAt + this.config.idle_timeout_ms;
    this.armIdleTimer(Math.max(0, localDeadline - this.now()));
  }

  private armIdleTimer(wait: number): void {
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.stopWhenIdle().catch((error: unknown) => {
        this.output?.appendLine(`[Forge] Could not stop idle sd-server: ${errorMessage(error)}`);
      });
    }, wait);
  }

  private async stopWhenIdle(): Promise<void> {
    if (this.activeUses > 0 || !this.proc || this.adopted) return;
    const record = await readSdServerRecord(this.recordPath, (message) =>
      this.output?.appendLine(message),
    );
    if (record && this.record) {
      if (!sameServer(record, this.record)) {
        throw new Error(
          `sd-server owner record "${this.recordPath}" changed process identity while idle; ` +
            'the running server was left untouched.',
        );
      }
      const sharedDeadline = record.lastUsedAt + this.config.idle_timeout_ms;
      if (sharedDeadline > this.now()) {
        this.armIdleTimer(sharedDeadline - this.now());
        return;
      }
    }
    await this.stopOwnedProcess();
  }

  private async stopOwnedProcess(): Promise<void> {
    this.clearIdleTimer();
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
  }

  private async handleProcessExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (this.proc !== child || this.adopted) return;
    this.proc = null;
    this.ready = false;
    this.clearIdleTimer();
    const exitedRecord = this.record;
    this.record = null;
    this.output?.appendLine(
      `[Forge] sd-server exited (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}); ` +
        'the next activity will attempt a restart.',
    );
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

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Same server process under the same config: pid + creation time + signature. */
function sameServer(a: SdServerOwnerRecord, b: SdServerOwnerRecord): boolean {
  return a.pid === b.pid && a.pidCreatedAt === b.pidCreatedAt && a.signature === b.signature;
}
