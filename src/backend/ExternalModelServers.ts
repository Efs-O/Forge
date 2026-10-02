import type { ForgeConfig, ModelConfig } from '../config/types';
import { mergeGroupsIntoModel } from '../config/ConfigResolver';
import { getLogger } from '../util/logger';

const log = getLogger();

/** How long an unload POST may take; Strata answers once the GPU is free. */
const UNLOAD_TIMEOUT_MS = 60_000;

type Residency = 'unknown' | 'loaded' | 'unloaded';

export type SecretLookup = (key: string) => Promise<string | undefined>;

/**
 * Local model servers Forge does not spawn but can unload (Strata): an
 * `openai-compatible` model with `unload_path`. The server process stays up;
 * POSTing the path frees its GPU/RAM and it reloads on its next request. The
 * pool treats each one as a resident model, so every unload command reaches it
 * and it never shares VRAM with a llama.cpp/Ollama model this window loads.
 * See docs/plans/EXTERNAL_SERVER_UNLOAD_PLAN.md.
 */
export class ExternalModelServers {
  private readonly residency = new Map<string, Residency>();

  constructor(
    private readonly getConfig: () => ForgeConfig,
    private readonly secret: SecretLookup,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The resolved model when `name` (a pool key) is a managed server. */
  private managed(name: string): ModelConfig | undefined {
    const config = this.getConfig();
    const raw = config.models.find((m) => m.name === name);
    if (!raw) return undefined;
    const model = mergeGroupsIntoModel(config, raw);
    return model.provider === 'openai-compatible' && model.unload_path ? model : undefined;
  }

  isManaged(name: string): boolean {
    return this.managed(name) !== undefined;
  }

  /** Unknown counts as loaded: a server started by hand may hold VRAM. */
  isLoaded(name: string): boolean {
    return this.isManaged(name) && this.residency.get(name) !== 'unloaded';
  }

  loadedNames(): string[] {
    return this.getConfig()
      .models.map((m) => m.name)
      .filter((name) => this.isLoaded(name));
  }

  /** A request is about to go to `name`; the server will load its model. */
  markInUse(name: string): void {
    if (this.isManaged(name)) this.residency.set(name, 'loaded');
  }

  async unload(name: string): Promise<void> {
    const model = this.managed(name);
    if (!model?.endpoint || !model.unload_path) return;
    const url = new URL(model.unload_path, model.endpoint).toString();
    const token = model.api_key_secret ? await this.secret(model.api_key_secret) : undefined;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(UNLOAD_TIMEOUT_MS),
      });
    } catch (err) {
      // No listening server holds no VRAM — the one error that means "unloaded".
      if (isConnectionRefused(err)) {
        this.residency.set(name, 'unloaded');
        log.info(`[ExternalModelServers] "${name}" is not running — nothing to unload`);
        return;
      }
      throw new Error(`Could not unload "${name}" (${url}): ${describe(err)}`);
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 300);
      const busy = response.status === 409 ? ' — a request is still running on it' : '';
      throw new Error(`Could not unload "${name}": HTTP ${response.status}${busy} ${body}`.trim());
    }
    this.residency.set(name, 'unloaded');
    log.info(`[ExternalModelServers] unloaded "${name}"`);
  }

  /** Unload every managed server that may hold memory; reports every failure. */
  async unloadAll(): Promise<void> {
    const results = await Promise.allSettled(this.loadedNames().map((n) => this.unload(n)));
    const failures = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
    if (failures.length) throw new Error(failures.join('\n'));
  }
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
}

function isConnectionRefused(err: unknown): boolean {
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  return (cause as { code?: string } | undefined)?.code === 'ECONNREFUSED';
}

/**
 * Runs before every openai-compatible request (`resolveCloudRequestTarget`).
 * The pool registers it at activation: a request to a managed server first
 * frees any local llama.cpp/Ollama model. Unset in tests and for configs
 * without managed servers.
 */
let requestHook: ((model: ModelConfig) => Promise<void>) | undefined;

export function setExternalRequestHook(
  hook: ((model: ModelConfig) => Promise<void>) | undefined,
): void {
  requestHook = hook;
}

export async function beforeExternalRequest(model: ModelConfig): Promise<void> {
  if (model.unload_path) await requestHook?.(model);
}
