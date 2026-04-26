import type { BackendController } from './BackendController';
import { waitForHealthy } from './HealthCheck';
import { getLogger } from '../util/logger';

const log = getLogger();

export interface BridgeBackendOptions {
  /** Base URL of an already-running OpenAI-compatible server, e.g. http://127.0.0.1:8080 */
  baseUrl: string;
  /** Optional health-check timeout in ms. Defaults to 10 s — bridge is pre-running. */
  healthTimeoutMs?: number;
}

/**
 * Connects to an already-running OpenAI-compatible server (Python bridge or
 * any external llama-server the user manages themselves).
 * Does not spawn or own any child process.
 */
export class BridgeBackend implements BackendController {
  private ready = false;
  private readonly url: string;
  private readonly healthTimeoutMs: number;
  private abortController: AbortController | null = null;

  constructor(opts: BridgeBackendOptions) {
    this.url = opts.baseUrl.replace(/\/$/, '');
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 10_000;
  }

  baseUrl(): string { return this.url; }
  isReady(): boolean { return this.ready; }

  async start(): Promise<void> {
    this.ready = false;
    this.abortController = new AbortController();

    log.info(`[BridgeBackend] checking ${this.url}`);

    const result = await waitForHealthy(
      { baseUrl: this.url, timeoutMs: this.healthTimeoutMs },
      undefined,
      this.abortController.signal,
    );

    if (!result.ok) {
      throw new Error(`BridgeBackend: server not reachable at ${this.url} — ${result.message}`);
    }

    this.ready = true;
    log.info('[BridgeBackend] ready');
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.abortController?.abort();
    this.abortController = null;
    // Bridge owns its own process — we do not kill it.
    log.info('[BridgeBackend] disconnected');
  }

  async hotSwap(modelName: string): Promise<void> {
    // Bridge manages model loading externally; we just update the name used in requests.
    log.info(`[BridgeBackend] model context switched to ${modelName} (bridge manages loading)`);
  }
}
