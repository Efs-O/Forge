import * as fs from 'fs';
import { randomBytes, randomUUID } from 'crypto';
import type { BusPaths } from '../agentBus/agentBus';
import { ensureBus } from '../agentBus/agentBus';
import {
  removeDeadWindowEndpoints,
  removeWindowEndpoint,
  writeWindowEndpoint,
} from '../agentBus/windowEndpoints';
import { getLogger } from '../util/logger';

const log = getLogger();

export class AgentWindowEndpointRegistry {
  readonly token: string;
  readonly windowId: string;
  private url: string | undefined;
  private enabled = false;

  constructor(
    private readonly paths: () => BusPaths,
    private readonly isFocused: () => boolean,
    token?: string,
    windowId?: string,
  ) {
    this.token = token ?? randomBytes(32).toString('hex');
    this.windowId = windowId ?? randomUUID();
    try {
      removeDeadWindowEndpoints(paths().root);
    } catch (error) {
      log.error('[agentRoutes] could not sweep dead window endpoints', error);
    }
  }

  onListening(url: string): void {
    this.url = url;
    this.refresh();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.refresh();
  }

  claim(): void {
    this.refresh();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  dispose(): void {
    this.url = undefined;
    this.withdrawClientEndpoint();
    this.withdrawWindowEndpoint();
  }

  private refresh(): void {
    try {
      if (!this.url || !this.enabled) {
        this.withdrawClientEndpoint();
        this.withdrawWindowEndpoint();
        return;
      }
      this.publishWindowEndpoint(this.url);
      if (this.isFocused()) this.publishClientEndpoint(this.url);
      else this.withdrawClientEndpoint();
    } catch (error) {
      log.error('[agentRoutes] could not update endpoint.json', error);
    }
  }

  private publishClientEndpoint(url: string): void {
    const paths = this.paths();
    ensureBus(paths);
    const temporary = `${paths.endpoint}.tmp`;
    const text = `${JSON.stringify({ url, token: this.token, pid: process.pid, windowId: this.windowId }, null, 2)}\n`;
    fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, paths.endpoint);
  }

  private publishWindowEndpoint(url: string): void {
    writeWindowEndpoint(this.paths().root, {
      windowId: this.windowId,
      url,
      token: this.token,
      pid: process.pid,
    });
  }

  private withdrawClientEndpoint(): void {
    const file = this.paths().endpoint;
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8')) as { token?: unknown };
      if (current.token === this.token) fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        log.error('[agentRoutes] could not withdraw endpoint.json', error);
    }
  }

  private withdrawWindowEndpoint(): void {
    try {
      removeWindowEndpoint(this.paths().root, this.windowId, this.token);
    } catch (error) {
      log.error('[agentRoutes] could not withdraw window endpoint', error);
    }
  }
}
