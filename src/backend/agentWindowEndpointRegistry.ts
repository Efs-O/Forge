import * as fs from 'fs';
import { randomBytes, randomUUID } from 'crypto';
import type { BusPaths } from '../agentBus/agentBus';
import { ensureBus } from '../agentBus/agentBus';
import {
  liveWindowEndpoints,
  processIsAlive,
  readWindowEndpoint,
  removeDeadWindowEndpoints,
  removeWindowEndpoint,
  writeWindowEndpoint,
  type WindowEndpoint,
} from '../agentBus/windowEndpoints';
import { getLogger } from '../util/logger';

const log = getLogger();

/**
 * The focused window owns the shared `endpoint.json` that `forge.sh` reads.
 * When no live window owns it (none focused since a reload, or the owner
 * closed or crashed), any live window takes it, and a closing owner hands it
 * to another live window. Until 2026-10-13 only a focused window published it,
 * so a window reloaded with nobody at the screen left `forge.sh` unreachable.
 */
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
    private readonly isAlive: (pid: number) => boolean = processIsAlive,
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
    this.releaseClientEndpoint();
    this.withdrawWindowEndpoint();
  }

  private refresh(): void {
    try {
      if (!this.url || !this.enabled) {
        this.releaseClientEndpoint();
        this.withdrawWindowEndpoint();
        return;
      }
      this.publishWindowEndpoint(this.url);
      // Unfocused, keep our own file and leave another live window's alone.
      if (this.isFocused() || !this.ownedByAnotherLiveWindow()) {
        this.publishClientEndpoint(this.ownEndpoint(this.url));
      }
    } catch (error) {
      log.error('[agentRoutes] could not update endpoint.json', error);
    }
  }

  private ownEndpoint(url: string): WindowEndpoint {
    return { windowId: this.windowId, url, token: this.token, pid: process.pid };
  }

  /** A missing, corrupt or dead-owner file has no owner, so this window may take it. */
  private ownedByAnotherLiveWindow(): boolean {
    const current = readWindowEndpoint(this.paths().endpoint);
    return current !== undefined && current.token !== this.token && this.isAlive(current.pid);
  }

  private publishClientEndpoint(endpoint: WindowEndpoint): void {
    const paths = this.paths();
    ensureBus(paths);
    const temporary = `${paths.endpoint}.tmp`;
    const { url, token, pid, windowId } = endpoint;
    const text = `${JSON.stringify({ url, token, pid, windowId }, null, 2)}\n`;
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

  /** Ours only: hand it to the newest other live window, or remove it when none is left. */
  private releaseClientEndpoint(): void {
    const file = this.paths().endpoint;
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8')) as { token?: unknown };
      if (current.token !== this.token) return;
      const [heir] = liveWindowEndpoints(this.paths().root, this.windowId, this.isAlive);
      if (heir) this.publishClientEndpoint(heir);
      else fs.unlinkSync(file);
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
