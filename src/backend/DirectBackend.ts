import { type ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import type { BackendController } from './BackendController';
import type { ForgeConfig, ModelConfig } from '../config/types';
import { composeLlamaServerArgs } from './LlamaServerArgs';
import { spawnLlamaServer, killLlamaProcess } from './llamaProcess';
import { waitForHealthy, probeHealthy, probeServedModel } from './HealthCheck';
import { ensureOllamaReady, normalizeOllamaEndpoint, probeOllamaModel, releaseOllamaModel } from './OllamaAdapter';
import { isCloudProvider } from '../llm/CloudProviders';
import { expandAlias, resolveSpawnModel, splitModelProfile } from '../config/ConfigResolver';
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
  private adoptPollTimer: ReturnType<typeof setInterval> | null = null;
  private onExitCb: (() => void) | null = null;

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

  /** Fired when a ready llama-server dies WITHOUT Forge stopping it (external
   *  kill, crash, adopted server vanishing) — never on stop()/hotSwap(). Lets
   *  the pool reconcile its slot table instead of reporting loaded=true for a
   *  dead process (RELAY_SMOKE_FINDINGS.md F5). */
  onUnexpectedExit(cb: () => void): void {
    this.onExitCb = cb;
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
    this.stopAdoptedMonitor();

    await this.releaseActiveOllamaModel();
    await this.stopLlamaServer();
    this.activeModel = null;
    this.currentBaseUrl = `http://${this.host}:${this.port}`;
    log.info('[DirectBackend] stopped');
  }

  async hotSwap(modelName: string): Promise<void> {
    const nextModel = this.resolveModel(modelName);
    if (isCloudProvider(nextModel.provider)) {
      throw new Error(
        `Model "${nextModel.name}" is a ${nextModel.provider} cloud-provider model — it has no local ` +
          `backend to load. It is called directly via the provider's API from the Forge sidebar.`,
      );
    }
    if (this.activeModel?.name === nextModel.name && this.ready) {
      // `ready` can be stale for daemon-backed models: the ollama server may
      // have died since. Re-verify cheaply; if dead, fall through to the full
      // re-ensure (which can auto-start the daemon).
      if (nextModel.provider !== 'ollama' || (await probeHealthy(this.currentBaseUrl))) {
        this.config.active_model = modelName;
        return;
      }
      this.ready = false;
    }

    // Old-model teardown is best-effort: a dead/hung daemon must never block
    // swapping AWAY from it. The adopted-server poll timer dies with the swap
    // too, so it cannot later flip `ready` for the wrong backend.
    this.stopAdoptedMonitor();
    await this.releaseActiveOllamaModel();

    if (this.activeModel?.provider === 'llama.cpp' || this.proc) {
      await this.stopLlamaServer();
    }

    this.ready = false;
    this.startAbort = new AbortController();

    if (nextModel.provider === 'ollama') {
      if (!nextModel.endpoint) {
        throw new Error(`Model "${nextModel.name}" is missing an Ollama endpoint.`);
      }
      await ensureOllamaReady(nextModel.endpoint, this.startAbort.signal, this.config.ollama);
      // Fail fast with the daemon's own reason (unknown model, entitlement
      // gate) instead of at first chat call.
      await probeOllamaModel(nextModel.endpoint, nextModel.name, this.startAbort.signal);
      this.activeModel = nextModel;
      this.currentBaseUrl = normalizeOllamaEndpoint(nextModel.endpoint);
      this.ready = true;
      this.config.active_model = modelName;
      log.info(`[DirectBackend] switched to Ollama model ${modelName}`);
      return;
    }

    await this.startLlamaServer(nextModel);
    this.activeModel = nextModel;
    this.currentBaseUrl = `http://${this.host}:${this.port}`;
    this.ready = true;
    this.config.active_model = modelName;
    log.info(`[DirectBackend] switched to llama.cpp model ${modelName}`);
  }

  private async startLlamaServer(model: ModelConfig): Promise<void> {
    const binary = this.config.llama_server.binary;
    if (!binary) {
      throw new Error('llama_server.binary is not configured. Set llama_server.binary in config.yaml to point to your llama-server executable.');
    }

    // If a server is already running on this port (e.g. another VS Code window),
    // adopt it instead of spawning a second process and doubling VRAM usage.
    // Adoption MUST be model-aware: every window computes the same fixed port
    // set, so a healthy server on this port may be serving a DIFFERENT model.
    // Adopting it blindly would silently answer requests with the wrong model.
    const baseUrl = `http://${this.host}:${this.port}`;
    if (await probeHealthy(baseUrl)) {
      const served = await probeServedModel(baseUrl);
      if (!this.servedModelMatches(served, model)) {
        const servedLabel = served ?? 'an unidentifiable model';
        throw new Error(
          `Port ${this.port} is already serving ${servedLabel}, not "${model.name}" ` +
            `(gguf: ${model.gguf_path ?? '?'}). Refusing to adopt it as the wrong model. ` +
            `Another VS Code window likely owns this port — close that model there, or ` +
            `route this load through the control server so it can free a slot.`,
        );
      }
      log.info(`[DirectBackend] port ${this.port} already serving ${model.name} — adopting existing server`);
      this.serverChannel ??= vscode.window.createOutputChannel('Forge - llama-server');
      this.serverChannel.clear();
      this.serverChannel.appendLine(`[Forge] Adopted existing llama-server on port ${this.port} (started by another VS Code window).`);
      this.serverChannel.appendLine(`[Forge] Live output is in that window. Polling /health + /slots every 5 s...\n`);
      this.serverChannel.show(true);
      this.startAdoptedMonitor();
      return;
    }

    const args = composeLlamaServerArgs(binary, model, this.config.llama_server, this.host, this.port);

    this.serverChannel ??= vscode.window.createOutputChannel('Forge - llama-server');
    this.serverChannel.clear();
    this.serverChannel.appendLine(`> ${binary} ${args.join(' ')}`);
    this.serverChannel.appendLine('');
    this.serverChannel.show(true);
    log.info(`[DirectBackend] spawn: ${binary} ${args.join(' ')}`);

    this.proc = spawnLlamaServer(binary, args);

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

    // Reconcile on external death: stopLlamaServer nulls this.proc BEFORE
    // killing, so an intentional stop/swap never reaches the callback.
    const proc = this.proc;
    proc?.once('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.ready = false;
      log.warn(`[DirectBackend] llama-server exited unexpectedly (code ${code ?? '?'})`);
      this.serverChannel?.appendLine(`\n[Forge] llama-server exited unexpectedly (code ${code ?? '?'}).`);
      this.onExitCb?.();
    });

    log.info('[DirectBackend] ready');
  }

  private startAdoptedMonitor(): void {
    if (this.adoptPollTimer) return;
    const baseUrl = `http://${this.host}:${this.port}`;
    this.adoptPollTimer = setInterval(async () => {
      try {
        const [healthRes, slotsRes] = await Promise.all([
          fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) }),
          fetch(`${baseUrl}/slots`, { signal: AbortSignal.timeout(3000) }),
        ]);
        if (!healthRes.ok) throw new Error(`HTTP ${healthRes.status}`);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const slots: any[] = slotsRes.ok ? (await slotsRes.json() as any[]) : [];
        const active = slots.filter((s) => s.state === 1).length;
        const total = slots.length;
        const ctx = slots[0] ? `${slots[0].n_past ?? 0}/${slots[0].n_ctx ?? '?'} ctx` : '';
        const ts = new Date().toLocaleTimeString();
        const line = [`[${ts}] llama-server healthy`, total ? `slots: ${active}/${total} active` : '', ctx]
          .filter(Boolean)
          .join(' | ');
        this.serverChannel?.appendLine(line);
      } catch {
        const ts = new Date().toLocaleTimeString();
        this.serverChannel?.appendLine(`\n[${ts}] llama-server stopped or unreachable.`);
        this.ready = false;
        this.stopAdoptedMonitor();
        this.onExitCb?.();
      }
    }, 5000);
  }

  private stopAdoptedMonitor(): void {
    if (this.adoptPollTimer) {
      clearInterval(this.adoptPollTimer);
      this.adoptPollTimer = null;
    }
  }

  /** Best-effort keep_alive:0 release of the active Ollama model. Never throws:
   *  an unreachable daemon must not wedge stop()/hotSwap(). */
  private async releaseActiveOllamaModel(): Promise<void> {
    if (this.activeModel?.provider !== 'ollama' || !this.activeModel.endpoint) return;
    try {
      await releaseOllamaModel(this.activeModel.endpoint, this.activeModel.name);
    } catch (err) {
      log.warn(
        `[DirectBackend] best-effort ollama release of "${this.activeModel.name}" failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async stopLlamaServer(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    await killLlamaProcess(proc);
  }

  /**
   * True when the identifier reported by a running server matches the model we
   * want to load. llama-server reports the `-m` path, so we compare against the
   * model's gguf_path by normalized full path and by basename (the server build
   * may report either). Returns false when the served model is unknown — we
   * refuse to adopt rather than risk serving the wrong model.
   */
  private servedModelMatches(served: string | null, model: ModelConfig): boolean {
    if (!served || !model.gguf_path) return false;
    const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
    const base = (p: string): string => norm(p).split('/').pop() ?? norm(p);
    return norm(served) === norm(model.gguf_path) || base(served) === base(model.gguf_path);
  }

  private resolveModel(name: string): ModelConfig {
    // Spawn-time resolution: a trailing @profile never forces a respawn, so we
    // key on the base model and flatten its spawn facts (F6). Profiles are
    // request-time only and are applied later by the agent loop / chat proxy.
    const { base } = splitModelProfile(expandAlias(this.config, name));
    const model = resolveSpawnModel(this.config, base);
    return {
      ...model,
      provider: model.provider ?? 'llama.cpp',
    };
  }
}
