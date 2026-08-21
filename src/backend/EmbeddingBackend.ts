import { type ChildProcess } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import { spawnLlamaServer, killLlamaProcess } from './llamaProcess';
import { waitForHealthy, probeHealthy, probeServedModel } from './HealthCheck';

/** EmbeddingGemma 300M's trained context window. Override via embeddings.n_ctx. */
const DEFAULT_EMBEDDING_CTX = 2048;
const DEFAULT_EMBEDDING_IDLE_TIMEOUT_MS = 120_000;

export function embeddingModelMatches(servedModel: string, configuredModelPath: string): boolean {
  return (
    path.normalize(path.resolve(servedModel)) === path.normalize(path.resolve(configuredModelPath))
  );
}

export class EmbeddingBackend implements vscode.Disposable {
  private proc: ChildProcess | null = null;
  private ready = false;
  private ownsProcess = false;
  private startAbort: AbortController | null = null;
  private startPromise: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeUses = 0;
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

  /** Returns confirmation metadata only when a new Forge-owned server is needed. */
  startApproval(): { detail: string } | undefined {
    const cfg = this.config.embeddings;
    if (!cfg?.enabled || cfg.confirm_on_start === false || this.ready || this.startPromise) {
      return undefined;
    }
    const timeout = this.idleTimeoutMs();
    return {
      detail:
        'Semantic code search will start EmbeddingGemma alongside the active model. ' +
        'It may consume significant additional VRAM and could cause an out-of-memory failure. ' +
        `If approved, Forge will unload it after ${Math.round(timeout / 1000)} seconds of inactivity.`,
    };
  }

  /** Keep the server alive while an indexing or query operation is running. */
  async withActivity<T>(operation: () => Promise<T>): Promise<T> {
    this.activeUses++;
    this.clearIdleTimer();
    try {
      return await operation();
    } finally {
      this.activeUses--;
      this.scheduleIdleStop();
    }
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
    if (this.startPromise) return this.startPromise;
    const promise = this.startInternal();
    this.startPromise = promise;
    try {
      await promise;
    } finally {
      if (this.startPromise === promise) this.startPromise = null;
    }
  }

  private async startInternal(): Promise<void> {
    const cfg = this.config.embeddings;
    const binary = this.config.llama_server.binary;
    if (!cfg?.enabled) {
      throw new Error(
        'Forge: embeddings are disabled. Set embeddings.enabled: true in config.yaml.',
      );
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
    const baseUrl = `http://${host}:${port}`;
    if (await probeHealthy(baseUrl)) {
      const servedModel = await probeServedModel(baseUrl);
      if (!servedModel) {
        throw new Error(
          `Embedding endpoint ${baseUrl} is already in use, but Forge could not verify its model. ` +
            'Stop the existing server or configure embeddings.port to an unused port.',
        );
      }
      if (!embeddingModelMatches(servedModel, cfg.model_path)) {
        throw new Error(
          `Embedding endpoint ${baseUrl} serves "${servedModel}", not the configured model "${cfg.model_path}". ` +
            'Stop the existing server or configure embeddings.port to an unused port.',
        );
      }
      this.ready = true;
      this.ownsProcess = false;
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
    this.ownsProcess = true;
    this.proc.stdout?.on('data', (chunk: Buffer) => this.output?.append(chunk.toString()));
    this.proc.stderr?.on('data', (chunk: Buffer) => this.output?.append(chunk.toString()));

    const result = await waitForHealthy({ baseUrl }, this.proc, this.startAbort.signal);
    if (!result.ok) {
      await this.stop();
      throw new Error(`Embedding server failed to start: ${result.message}`);
    }

    this.ready = true;
    this.currentSignature = signature;
    this.scheduleIdleStop();
  }

  async stop(): Promise<void> {
    this.clearIdleTimer();
    this.ready = false;
    this.currentSignature = null;
    this.startAbort?.abort();
    this.startAbort = null;
    this.ownsProcess = false;
    if (!this.proc) return;

    const proc = this.proc;
    this.proc = null;
    await killLlamaProcess(proc);
  }

  private idleTimeoutMs(): number {
    return this.config.embeddings?.idle_timeout_ms ?? DEFAULT_EMBEDDING_IDLE_TIMEOUT_MS;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdleStop(): void {
    this.clearIdleTimer();
    // Never terminate a server Forge did not spawn; it may belong to another
    // Forge window or an external caller that owns its lifecycle.
    if (!this.proc || !this.ownsProcess || this.activeUses > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.activeUses === 0 && this.proc) void this.stop();
    }, this.idleTimeoutMs());
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

export function composeEmbeddingServerArgs(config: ForgeConfig): string[] {
  const modelPath = config.embeddings?.model_path;
  if (!modelPath) throw new Error('Forge: embeddings.model_path is not configured.');

  const host = config.llama_server.host ?? '127.0.0.1';
  const port = config.embeddings?.port ?? 8091;
  const args = ['-m', modelPath, '--host', host, '--port', String(port), '--embedding'];

  const gpuLayers = config.llama_server.n_gpu_layers;
  if (gpuLayers !== undefined) args.push('--n-gpu-layers', String(gpuLayers));

  // Embedding inputs are pooled non-causally, so llama.cpp cannot split one
  // input across physical batches: the whole chunk must fit in n_ubatch or the
  // request fails with HTTP 500 "input is too large to process". Chunks from
  // chunking.ts run to 120 lines (well over llama.cpp's 512 default), so ctx,
  // batch and ubatch are pinned together to the embedding model's own window.
  // The chat model's llama_server ctx/batch are deliberately NOT inherited —
  // they describe a different model with a different window.
  const ctx = config.embeddings?.n_ctx ?? DEFAULT_EMBEDDING_CTX;
  args.push('--ctx-size', String(ctx));
  args.push('--batch-size', String(ctx));
  args.push('--ubatch-size', String(ctx));

  const threads = config.llama_server.n_threads;
  if (threads !== undefined && threads > 0) args.push('--threads', String(threads));

  const threadsBatch = config.llama_server.n_threads_batch;
  if (threadsBatch !== undefined && threadsBatch > 0)
    args.push('--threads-batch', String(threadsBatch));

  return args;
}
