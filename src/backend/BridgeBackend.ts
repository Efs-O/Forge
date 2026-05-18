import type { BackendController } from './BackendController';
import type { ForgeConfig, ModelConfig } from '../config/types';
import { waitForHealthy } from './HealthCheck';
import { ensureOllamaReady, normalizeOllamaEndpoint, releaseOllamaModel } from './OllamaAdapter';
import { getLogger } from '../util/logger';

const log = getLogger();

export interface BridgeBackendOptions {
  /** Base URL of an already-running OpenAI-compatible server, e.g. http://127.0.0.1:8080 */
  baseUrl: string;
  /** Optional health-check timeout in ms. Defaults to 10 s because the server is pre-running. */
  healthTimeoutMs?: number;
}

/**
 * Connects to an already-running OpenAI-compatible server. This implementation
 * does not spawn any process, but it can still release Ollama-backed models
 * when the selected entry points at an Ollama endpoint.
 */
export class BridgeBackend implements BackendController {
  private ready = false;
  private defaultUrl: string;
  private readonly healthTimeoutMs: number;
  private abortController: AbortController | null = null;
  private currentModel: ModelConfig | null = null;
  private currentBaseUrl: string;

  constructor(
    opts: BridgeBackendOptions,
    private config: ForgeConfig,
  ) {
    this.defaultUrl = opts.baseUrl.replace(/\/$/, '');
    this.currentBaseUrl = this.defaultUrl;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 10_000;
  }

  /** Replace merged Forge config after YAML reload (same reference shared with SidebarProvider). */
  applyForgeConfig(next: ForgeConfig): void {
    this.config = next;
    this.defaultUrl = `http://${next.llama_server.host ?? '127.0.0.1'}:${next.llama_server.port ?? 8080}`.replace(
      /\/$/,
      '',
    );
  }

  baseUrl(): string {
    return this.currentBaseUrl;
  }

  isReady(): boolean {
    return this.ready;
  }

  showConsole(): void {
    log.show();
  }

  loadedModel(): string | null {
    return this.currentModel?.name ?? null;
  }

  async start(): Promise<void> {
    if (!this.config.active_model) {
      throw new Error('Forge: no active model selected. Pick a model before starting the backend.');
    }
    await this.hotSwap(this.config.active_model);
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.abortController?.abort();
    this.abortController = null;

    if (this.currentModel?.provider === 'ollama' && this.currentModel.endpoint) {
      await releaseOllamaModel(this.currentModel.endpoint, this.currentModel.name);
    }

    this.currentModel = null;
    this.currentBaseUrl = this.defaultUrl;
    log.info('[BridgeBackend] disconnected');
  }

  async hotSwap(modelName: string): Promise<void> {
    const nextModel = this.resolveModel(modelName);
    if (this.currentModel?.name === nextModel.name && this.ready) {
      this.config.active_model = nextModel.name;
      return;
    }

    if (this.currentModel?.provider === 'ollama' && this.currentModel.endpoint) {
      await releaseOllamaModel(this.currentModel.endpoint, this.currentModel.name);
    }

    this.ready = false;
    this.abortController = new AbortController();
    const nextBaseUrl = nextModel.provider === 'ollama' && nextModel.endpoint
      ? normalizeOllamaEndpoint(nextModel.endpoint)
      : this.defaultUrl;

    if (nextModel.provider === 'ollama' && nextModel.endpoint) {
      await ensureOllamaReady(nextModel.endpoint, this.abortController.signal);
    } else {
      const result = await waitForHealthy(
        { baseUrl: nextBaseUrl, timeoutMs: this.healthTimeoutMs },
        undefined,
        this.abortController.signal,
      );

      if (!result.ok) {
        throw new Error(`BridgeBackend: server not reachable at ${nextBaseUrl} - ${result.message}`);
      }
    }

    this.currentModel = nextModel;
    this.currentBaseUrl = nextBaseUrl;
    this.ready = true;
    this.config.active_model = nextModel.name;
    log.info(`[BridgeBackend] switched to ${modelName}`);
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
