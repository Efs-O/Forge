import type { BackendController } from './BackendController';
import type { ForgeConfig } from '../config/types';
import type { IBackendPool } from './BackendPool';

/**
 * Wraps a single BackendController (e.g. BridgeBackend) so SidebarProvider
 * can always call pool.acquire() regardless of direct vs. bridge mode.
 */
export class SingleBackendPool implements IBackendPool {
  constructor(private readonly backend: BackendController) {}

  async acquire(_modelName: string): Promise<BackendController> {
    return this.backend;
  }

  async release(_modelName: string): Promise<void> {
    // Bridge mode manages its own lifecycle — no per-model release.
  }

  async stopAll(): Promise<void> {
    await this.backend.stop();
  }

  applyForgeConfig(next: ForgeConfig): void {
    this.backend.applyForgeConfig(next);
  }

  showConsole(_modelName?: string): void {
    this.backend.showConsole();
  }

  isAnyReady(): boolean {
    return this.backend.isReady();
  }
}
