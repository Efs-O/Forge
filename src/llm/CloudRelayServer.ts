import * as http from 'http';
import { randomUUID } from 'crypto';
import type * as vscode from 'vscode';
import { mergeGroupsIntoModel } from '../config/ConfigResolver';
import type { ForgeConfig, ModelConfig } from '../config/types';
import { normalizeOllamaEndpoint } from '../backend/OllamaAdapter';
import { createTailnetListener, type TailnetListener } from '../backend/TailnetListener';
import { sendJson } from '../backend/httpJson';
import { getLogger } from '../util/logger';
import { isCloudProvider } from './CloudProviders';
import { resolveCloudRequestTarget } from './CloudRequestResolver';
import { forwardCloudRequest } from './CloudRelayForward';
import { isOllamaCloudModel } from './ModelRouteClassifier';

/** The cloud relay's complete HTTP surface; changes are CI-locked. */
export const CLOUD_RELAY_ROUTES = Object.freeze([
  'GET /v1/models',
  'POST /v1/chat/completions',
  'POST /api/chat',
  'POST /api/generate',
] as const);

const log = getLogger();

export interface CloudRelayWiring {
  applyConfig(): void;
  dispose(): void;
}

function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function logLocalRequest(
  route: string,
  model: string,
  status: number,
  startedAt: number,
  bytesIn: number,
  bytesOut: number,
): void {
  log.info(
    `[CloudRelay] id=${randomUUID()} route=${route} model=${model} status=${status} ` +
      `duration_ms=${Date.now() - startedAt} bytes_in=${bytesIn} bytes_out=${bytesOut}`,
  );
}

class CloudRelayServer implements CloudRelayWiring {
  private listener: TailnetListener | null = null;
  private activePort: number | undefined;
  private activeBodyCap: number | undefined;
  private readonly inFlight = new Set<AbortController>();
  private disposed = false;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly getConfig: () => ForgeConfig,
  ) {}

  applyConfig(): void {
    const relay = this.getConfig().cloud_relay;
    if (this.disposed || !relay?.enabled) {
      this.stopListener();
      return;
    }
    const bodyCap = relay.max_body_mb * 1024 * 1024;
    if (this.listener && this.activePort === relay.port && this.activeBodyCap === bodyCap) return;
    this.stopListener();
    this.activePort = relay.port;
    this.activeBodyCap = bodyCap;
    this.listener = createTailnetListener({
      port: relay.port,
      routes: CLOUD_RELAY_ROUTES,
      maxBodyBytes: bodyCap,
      label: 'CloudRelay',
      requestTimeoutMs: 0,
      headersTimeoutMs: 60_000,
      log,
      originError: 'Origin header is not accepted by the cloud relay',
      onRejected: (route, status, startedAt, bytesIn) =>
        logLocalRequest(route, '-', status, startedAt, bytesIn, 0),
      onRequest: (req, res, route, body) => this.handle(req, res, route, body),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopListener();
  }

  private stopListener(): void {
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
    this.listener?.dispose();
    this.listener = null;
    this.activePort = undefined;
    this.activeBodyCap = undefined;
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const startedAt = Date.now();
    const bytesIn = Buffer.byteLength(JSON.stringify(body));
    if (route === 'GET /v1/models') {
      const entries = this.allowlisted();
      const models = entries.flatMap(({ configured, model }) => {
        if (!this.isRelayModel(model)) return [];
        return [
          {
            id: configured.name,
            owned_by: 'forge-relay',
            kind: model.provider === 'ollama' ? 'ollama' : 'openai',
          },
        ];
      });
      const result = { object: 'list', data: models };
      const output = JSON.stringify(result);
      sendJson(res, 200, result);
      logLocalRequest(route, '-', 200, startedAt, bytesIn, Buffer.byteLength(output));
      return;
    }
    const name = typeof body.model === 'string' ? body.model : '';
    if (!name.trim()) {
      const result = { error: { message: 'body.model must be a non-empty string' } };
      const output = JSON.stringify(result);
      sendJson(res, 400, result);
      logLocalRequest(route, '-', 400, startedAt, bytesIn, Buffer.byteLength(output));
      return;
    }
    const model = this.findAllowedModel(name);
    if (!model) {
      const gone = this.noLongerOnDesktop(name);
      const result = {
        error: {
          message:
            `model "${name}" is not allowlisted by the desktop cloud relay` +
            (gone
              ? ` — "${name}" is no longer configured on the desktop: it is still ` +
                'listed in `cloud_relay.models`, but the model entry is gone.'
              : ''),
        },
      };
      const output = JSON.stringify(result);
      sendJson(res, 404, result);
      logLocalRequest(route, name || '-', 404, startedAt, bytesIn, Buffer.byteLength(output));
      return;
    }
    if (route === 'POST /api/generate') {
      if (!isOllamaCloudModel(model) || Object.keys(body).length !== 2 || body.keep_alive !== 0) {
        const result = {
          error: {
            message: 'body must be exactly {model, keep_alive: 0} for an Ollama cloud model',
          },
        };
        const output = JSON.stringify(result);
        sendJson(res, 400, result);
        logLocalRequest(route, name, 400, startedAt, bytesIn, Buffer.byteLength(output));
        return;
      }
      sendJson(res, 200, { model: name, done: true });
      logLocalRequest(
        route,
        name,
        200,
        startedAt,
        bytesIn,
        Buffer.byteLength(JSON.stringify({ model: name, done: true })),
      );
      return;
    }
    const isOllamaRoute = route === 'POST /api/chat';
    if (
      (isOllamaRoute && !isOllamaCloudModel(model)) ||
      (!isOllamaRoute && !this.isRelayModel(model))
    ) {
      const result = { error: { message: `model "${name}" is not valid for ${route}` } };
      const output = JSON.stringify(result);
      sendJson(res, 404, result);
      logLocalRequest(route, name, 404, startedAt, bytesIn, Buffer.byteLength(output));
      return;
    }
    if (isOllamaRoute && !isLoopbackEndpoint(model.endpoint ?? '')) {
      const result = { error: { message: 'desktop Ollama cloud endpoint must be loopback' } };
      const output = JSON.stringify(result);
      sendJson(res, 422, result);
      logLocalRequest(route, name, 422, startedAt, bytesIn, Buffer.byteLength(output));
      return;
    }
    const controller = new AbortController();
    this.inFlight.add(controller);
    await forwardCloudRequest({
      req,
      res,
      body,
      model,
      route,
      upstreamPath: isOllamaRoute ? '/api/chat' : '/v1/chat/completions',
      resolveTarget: (targetModel) =>
        isOllamaRoute
          ? Promise.resolve({ baseUrl: normalizeOllamaEndpoint(targetModel.endpoint!), apiKey: '' })
          : resolveCloudRequestTarget(targetModel, this.extensionContext.secrets),
      shutdownSignal: controller.signal,
      logLine: (line) => log.info(line),
    });
    this.inFlight.delete(controller);
  }

  private allowlisted(): Array<{ configured: ModelConfig; model: ModelConfig }> {
    const config = this.getConfig();
    const allowed = config.cloud_relay?.models ?? [];
    return allowed.flatMap((name) => {
      const configured = config.models.find((entry) => entry.name === name);
      return configured ? [{ configured, model: mergeGroupsIntoModel(config, configured) }] : [];
    });
  }

  private findAllowedModel(name: string): ModelConfig | undefined {
    return this.allowlisted().find((entry) => entry.configured.name === name)?.model;
  }

  /** True when `name` is still in `cloud_relay.models` while its model entry is
   *  gone. That is the difference between "you may not ask for this" and "this
   *  no longer exists", and the laptop cannot tell them apart from here unless
   *  the relay says so — the allowlist is edited by hand and drifts whenever a
   *  model is deleted on the desktop. */
  private noLongerOnDesktop(name: string): boolean {
    const config = this.getConfig();
    return (
      (config.cloud_relay?.models ?? []).includes(name) &&
      !config.models.some((entry) => entry.name === name)
    );
  }

  private isRelayModel(model: ModelConfig): boolean {
    if (model.provider === 'ollama')
      return isOllamaCloudModel(model) && isLoopbackEndpoint(model.endpoint ?? '');
    return isCloudProvider(model.provider);
  }
}

/** Owns listener lifecycle at activation and on each accepted config reload. */
export function wireCloudRelay(
  extensionContext: vscode.ExtensionContext,
  getConfig: () => ForgeConfig,
): CloudRelayWiring {
  const server = new CloudRelayServer(extensionContext, getConfig);
  server.applyConfig();
  return server;
}
