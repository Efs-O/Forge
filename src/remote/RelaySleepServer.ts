import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { createServer, type IncomingMessage, type Server } from 'http';
import type * as vscode from 'vscode';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { PowerControl } from '../system/PowerControl';

export const RELAY_SLEEP_SECRET = 'forge.remote.wakeRelay.secret';
const MAX_BODY_BYTES = 128;
const MAX_CLOCK_SKEW_MS = 90_000;

export interface RelaySleepServerOptions {
  host: string;
  port: number;
  relayIp: string;
  secrets: vscode.SecretStorage;
  forge: ForgeHostFacade;
  notify: (message: string) => void;
}

/** Private-LAN receiver for an already-confirmed WakeSleepBot request. */
export class RelaySleepServer implements vscode.Disposable {
  private server: Server | undefined;
  private readonly seen = new Map<string, number>();
  private readonly power = new PowerControl();

  async start(options: RelaySleepServerOptions): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => void this.handle(request, response, options));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(options.port, options.host, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
    this.seen.clear();
  }

  private async handle(
    request: IncomingMessage,
    response: import('http').ServerResponse,
    options: RelaySleepServerOptions,
  ): Promise<void> {
    if (
      request.method !== 'POST' ||
      request.url !== '/v1/sleep' ||
      !this.fromRelay(request, options.relayIp)
    ) {
      return this.reply(response, 404, 'not found');
    }
    const body = await this.readBody(request).catch(() => undefined);
    const timestamp = request.headers['x-forge-relay-timestamp'];
    const nonce = request.headers['x-forge-relay-nonce'];
    const signature = request.headers['x-forge-relay-signature'];
    const secret = await options.secrets.get(RELAY_SLEEP_SECRET);
    if (
      !body ||
      typeof timestamp !== 'string' ||
      typeof nonce !== 'string' ||
      typeof signature !== 'string' ||
      !secret
    ) {
      return this.reply(response, 401, 'unauthorized');
    }
    const time = Number(timestamp);
    if (
      !Number.isSafeInteger(time) ||
      Math.abs(Date.now() - time * 1000) > MAX_CLOCK_SKEW_MS ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
      this.seen.has(nonce)
    ) {
      return this.reply(response, 401, 'expired request');
    }
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${nonce}.${body}`)
      .digest('hex');
    if (
      !/^[a-f0-9]{64}$/i.test(signature) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(signature.toLowerCase()))
    ) {
      return this.reply(response, 401, 'unauthorized');
    }
    this.pruneSeen();
    this.seen.set(nonce, Date.now() + MAX_CLOCK_SKEW_MS);
    if (body !== '{"action":"sleep"}') return this.reply(response, 400, 'invalid request');
    const status = options.forge.status();
    if (
      status.streamingConversationIds.length ||
      status.requestChains.length ||
      status.pendingApproval
    ) {
      return this.reply(response, 409, 'Forge is busy; sleep was not requested');
    }
    this.reply(response, 202, 'sleep accepted');
    setTimeout(() => {
      void this.power
        .suspend()
        .catch((error: unknown) =>
          options.notify(
            `Forge relay sleep failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    }, 2_000).unref?.();
  }

  private fromRelay(request: IncomingMessage, relayIp: string): boolean {
    const remote = request.socket.remoteAddress?.replace(/^::ffff:/, '');
    return remote === relayIp;
  }

  private async readBody(request: IncomingMessage): Promise<string> {
    let body = '';
    for await (const chunk of request) {
      body += String(chunk);
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('too large');
    }
    return body;
  }

  private pruneSeen(): void {
    for (const [nonce, expires] of this.seen) if (expires < Date.now()) this.seen.delete(nonce);
  }

  private reply(response: import('http').ServerResponse, status: number, text: string): void {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(text);
  }
}

export function newRelaySecret(): string {
  return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
}
