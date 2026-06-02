import { type ChildProcess } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import { spawnLlamaServer, killLlamaProcess } from './llamaProcess';
import { waitForHealthy, probeHealthy } from './HealthCheck';

export class EmbeddingBackend implements vscode.Disposable {
  private proc: ChildProcess | null = null;
  private ready = false;
  private startAbort: AbortController | null = null;
  private output: vscode.OutputChannel | null = null;
  private currentSignature: string | null = null;

  constructor(private config: ForgeConfig) {}

  applyForgeConfig(next: ForgeConfig): void {
    this.config = next;
  }

  isConfigured(): boolean {
    return this.config.embeddings?.enabled === true;
  }

  isReady(): boolean {
    return this.ready;
  }

  baseUrl(): string {
    const host = this.config.llama_server.host ?? '127.0.0.1';
    const port = this.config.embeddings?.port ?? 8091;
    return `http://${host}:${port}`;
  }

  showConsole(): void {
    this.output ??= vscode.window.createOutputChannel('Forge - embeddings');
    this.output.show(true);
  }

  async start(): Promise<void> {
    const cfg = this.config.embeddings;
    const binary = this.config.llama_server.binary;
    if (!cfg?.enabled) {
      throw new Error('Forge: embeddings are disabled. Set embeddings.enabled: true in config.yaml.');
    }
    if (!cfg.model_path) {
      throw new Error('Forge: embeddings.model_path is not configured.');
    }
    if (!binary) {
      throw new Error('Forge: llama_server.binary is required when embeddings are enabled.');
    }

    const signature = `${path.resolve(cfg.model_path)}|${this.baseUrl()}`;
    if (this.ready && this.currentSignature === signature) return;
    if (this.proc || this.currentSignature !== signature) {
      await this.stop();
    }

    const host = this.config.llama_server.host ?? '127.0.0.1';
    const port = cfg.port ?? 8091;
    if (await probeHealthy(`http://${host}:${port}`)) {
      this.ready = true;
      this.currentSignature = signature;
      this.output ??= vscode.window.createOutputChannel('Forge - embeddings');
      this.output.appendLine(`[Forge] Adopted existing embedding server on port ${port}.`);
      return;
    }

    const args = composeEmbeddingServerArgs(this.config);
    this.startAbort = new AbortController();
    this.output ??= vscode.window.createOutputChannel('Forge - embeddings');
    this.output.clear();
    this.output.appendLine(`> ${binary} ${args.join(' ')}`);
    this.output.appendLine('');

    this.proc = spawnLlamaServer(binary, args);
    this.proc.stdout?.on('data', (chunk: Buffer) => this.output?.append(chunk.toString()));
    this.proc.stderr?.on('data', (chunk: Buffer) => this.output?.append(chunk.toString()));

    const result = await waitForHealthy({ baseUrl: this.baseUrl() }, this.proc, this.startAbort.signal);
    if (!result.ok) {
      await this.stop();
      throw new Error(`Embedding server failed to start: ${result.message}`);
    }

    this.ready = true;
    this.currentSignature = signature;
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.currentSignature = null;
    this.startAbort?.abort();
    this.startAbort = null;
    if (!this.proc) return;

    const proc = this.proc;
    this.proc = null;
    await killLlamaProcess(proc);
  }

  /**
   * VS Code disposal hook. Registered via context.subscriptions so the spawned
   * embedding `llama-server` is torn down on deactivate / window close instead
   * of leaking. Best-effort: stop() is async, dispose() is sync.
   */
  dispose(): void {
    void this.stop();
    this.output?.dispose();
    this.output = null;
  }
}

function composeEmbeddingServerArgs(config: ForgeConfig): string[] {
  const modelPath = config.embeddings?.model_path;
  if (!modelPath) throw new Error('Forge: embeddings.model_path is not configured.');

  const host = config.llama_server.host ?? '127.0.0.1';
  const port = config.embeddings?.port ?? 8091;
  const args = [
    '-m', modelPath,
    '--host', host,
    '--port', String(port),
    '--embedding',
  ];

  const gpuLayers = config.llama_server.n_gpu_layers;
  if (gpuLayers !== undefined) args.push('--n-gpu-layers', String(gpuLayers));

  const ctx = config.llama_server.default_num_ctx;
  if (ctx !== undefined) args.push('--ctx-size', String(ctx));

  const batch = config.llama_server.n_batch;
  if (batch !== undefined) args.push('--batch-size', String(batch));

  const threads = config.llama_server.n_threads;
  if (threads !== undefined && threads > 0) args.push('--threads', String(threads));

  const threadsBatch = config.llama_server.n_threads_batch;
  if (threadsBatch !== undefined && threadsBatch > 0) args.push('--threads-batch', String(threadsBatch));

  return args;
}
