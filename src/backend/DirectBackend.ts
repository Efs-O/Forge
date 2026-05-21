import { spawn, type ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import type { BackendController } from './BackendController';
import type { ForgeConfig, ModelConfig } from '../config/types';
import { composeLlamaServerArgs } from './LlamaServerArgs';
import { waitForHealthy, probeHealthy } from './HealthCheck';
import { ensureOllamaReady, normalizeOllamaEndpoint, releaseOllamaModel } from './OllamaAdapter';
import { getLogger } from '../util/logger';

const log = getLogger();

export class DirectBackend implements BackendController {
  private proc: ChildProcess | null = null;
  private ready = false;
  private startAbort: AbortController | null = null;
  private serverChannel: vscode.OutputChannel | null = null;
  private readonly host: string;
  private readonly port: number;
  private activeModel: ModelConfig | null = null;
  private currentBaseUrl: string;

  constructor(private config: ForgeConfig, portOverride?: number) {
    this.host = config.llama_server.host ?? '127.0.0.1';
    this.port = portOverride ?? config.llama_server.port ?? 8080;
    this.currentBaseUrl = `http://${this.host}:${this.port}`;
  }

  /** Replace merged Forge config after YAML reload (same reference shared with SidebarProvider). */
  applyForgeConfig(next: ForgeConfig): void {
    this.config = next;
  }

  baseUrl(): string {
    return this.currentBaseUrl;
  }

  isReady(): boolean {
    return this.ready;
  }

  showConsole(): void {
    this.serverChannel ??= vscode.window.createOutputChannel('Forge - llama-server');
    this.serverChannel.show(true);
  }

  loadedModel(): string | null {
    return this.activeModel?.name ?? null;
  }

  async start(): Promise<void> {
    if (!this.config.active_model) {
      throw new Error('Forge: no active model selected. Pick a model before starting the backend.');
    }
    await this.hotSwap(this.config.active_model);
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.startAbort?.abort();
    this.startAbort = null;

    if (this.activeModel?.provider === 'ollama' && this.activeModel.endpoint) {
      await releaseOllamaModel(this.activeModel.endpoint, this.activeModel.name);
    }

    await this.stopLlamaServer();
    this.activeModel = null;
    this.currentBaseUrl = `http://${this.host}:${this.port}`;
    log.info('[DirectBackend] stopped');
  }

  async hotSwap(modelName: string): Promise<void> {
    const nextModel = this.resolveModel(modelName);
    if (this.activeModel?.name === nextModel.name && this.ready) {
      this.config.active_model = nextModel.name;
      return;
    }

    if (this.activeModel?.provider === 'ollama' && this.activeModel.endpoint) {
      await releaseOllamaModel(this.activeModel.endpoint, this.activeModel.name);
    }

    if (this.activeModel?.provider === 'llama.cpp' || this.proc) {
      await this.stopLlamaServer();
    }

    this.ready = false;
    this.startAbort = new AbortController();

    if (nextModel.provider === 'ollama') {
      if (!nextModel.endpoint) {
        throw new Error(`Model "${nextModel.name}" is missing an Ollama endpoint.`);
      }
      await ensureOllamaReady(nextModel.endpoint, this.startAbort.signal);
      this.activeModel = nextModel;
      this.currentBaseUrl = normalizeOllamaEndpoint(nextModel.endpoint);
      this.ready = true;
      this.config.active_model = nextModel.name;
      log.info(`[DirectBackend] switched to Ollama model ${modelName}`);
      return;
    }

    await this.startLlamaServer(nextModel);
    this.activeModel = nextModel;
    this.currentBaseUrl = `http://${this.host}:${this.port}`;
    this.ready = true;
    this.config.active_model = nextModel.name;
    log.info(`[DirectBackend] switched to llama.cpp model ${modelName}`);
  }

  private async startLlamaServer(model: ModelConfig): Promise<void> {
    const binary = this.config.llama_server.binary;
    if (!binary) {
      throw new Error('llama_server.binary is not configured. Set bridge_mode: true to connect to a pre-running server.');
    }

    // If a server is already running on this port (e.g. another VS Code window),
    // adopt it instead of spawning a second process and doubling VRAM usage.
    if (await probeHealthy(`http://${this.host}:${this.port}`)) {
      log.info(`[DirectBackend] port ${this.port} already healthy — adopting existing server`);
      return;
    }

    const args = composeLlamaServerArgs(binary, model, this.config.llama_server, this.host, this.port);

    this.serverChannel ??= vscode.window.createOutputChannel('Forge - llama-server');
    this.serverChannel.clear();
    this.serverChannel.appendLine(`> ${binary} ${args.join(' ')}`);
    this.serverChannel.appendLine('');
    this.serverChannel.show(true);
    log.info(`[DirectBackend] spawn: ${binary} ${args.join(' ')}`);

    this.proc = spawn(binary, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => this.serverChannel?.append(chunk.toString()));
    this.proc.stderr?.on('data', (chunk: Buffer) => this.serverChannel?.append(chunk.toString()));
    this.proc.once('error', (err) => {
      log.error(`[DirectBackend] spawn error: ${err.message}`);
      this.serverChannel?.appendLine(`\n[ERROR] ${err.message}`);
    });

    const abort = this.startAbort;
    const result = await waitForHealthy(
      { baseUrl: `http://${this.host}:${this.port}` },
      this.proc,
      abort?.signal,
    );

    if (!result.ok) {
      await this.stopLlamaServer();
      throw new Error(`llama-server failed to start: ${result.message}`);
    }

    log.info('[DirectBackend] ready');
  }

  private async stopLlamaServer(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      proc.once('exit', finish);
      proc.once('error', finish);

      if (process.platform === 'win32' && proc.pid) {
        try {
          proc.kill();
        } catch {
          // ignore and fall through to taskkill
        }

        const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
          shell: false,
          stdio: 'ignore',
        });
        killer.once('exit', () => setTimeout(finish, 250));
        killer.once('error', () => setTimeout(finish, 250));
      } else {
        try {
          proc.kill('SIGTERM');
        } catch {
          finish();
          return;
        }

        setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // process likely already exited
          }
        }, 5000);
      }

      setTimeout(finish, 6000);
    });
  }

  private resolveModel(name: string): ModelConfig {
    const model = this.config.models.find((entry) => entry.name === name);
    if (!model) throw new Error(`Model "${name}" not found in config`);
    return {
      ...model,
      provider: model.provider ?? 'llama.cpp',
    };
  }
}
