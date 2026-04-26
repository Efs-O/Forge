import { spawn, type ChildProcess } from 'child_process';
import type { BackendController } from './BackendController';
import type { ForgeConfig, ModelConfig } from '../config/types';
import { composeLlamaServerArgs } from './LlamaServerArgs';
import { waitForHealthy } from './HealthCheck';
import { getLogger } from '../util/logger';

const log = getLogger();

export class DirectBackend implements BackendController {
  private proc: ChildProcess | null = null;
  private ready = false;
  private startAbort: AbortController | null = null;

  private host: string;
  private port: number;
  private activeModel: ModelConfig;

  constructor(private config: ForgeConfig) {
    this.host = config.llama_server.host ?? '127.0.0.1';
    this.port = config.llama_server.port ?? 8080;
    this.activeModel = this.resolveModel(config.active_model);
  }

  baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  isReady(): boolean {
    return this.ready;
  }

  async start(): Promise<void> {
    if (this.proc) await this.stop();
    this.ready = false;
    this.startAbort = new AbortController();

    const binary = this.config.llama_server.binary;
    if (!binary) {
      throw new Error('llama_server.binary is not configured. Set bridge_mode: true to connect to a pre-running server.');
    }
    const args = composeLlamaServerArgs(binary, this.activeModel, this.config.llama_server, this.host, this.port);

    log.info(`[DirectBackend] spawn: ${binary} ${args.join(' ')}`);

    this.proc = spawn(binary, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => log.trace(`[llama-server] ${chunk.toString().trimEnd()}`));
    this.proc.stderr?.on('data', (chunk: Buffer) => log.trace(`[llama-server] ${chunk.toString().trimEnd()}`));
    this.proc.once('error', (err) => log.error(`[DirectBackend] spawn error: ${err.message}`));

    const result = await waitForHealthy(
      { baseUrl: this.baseUrl() },
      this.proc,
      this.startAbort.signal,
    );

    if (!result.ok) {
      await this.stop();
      throw new Error(`llama-server failed to start: ${result.message}`);
    }
    this.ready = true;
    log.info('[DirectBackend] ready');
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.startAbort?.abort();
    this.startAbort = null;

    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;

    await new Promise<void>((resolve) => {
      p.once('exit', () => resolve());
      p.kill('SIGTERM');
      // Force-kill after 5 s if it hasn't exited.
      setTimeout(() => { if (!p.killed) p.kill('SIGKILL'); }, 5000);
    });
    log.info('[DirectBackend] stopped');
  }

  async hotSwap(modelName: string): Promise<void> {
    this.activeModel = this.resolveModel(modelName);
    log.info(`[DirectBackend] hot-swap → ${modelName}`);
    await this.start();
  }

  private resolveModel(name: string): ModelConfig {
    const m = this.config.models.find((m) => m.name === name);
    if (!m) throw new Error(`Model "${name}" not found in config`);
    return m;
  }
}
