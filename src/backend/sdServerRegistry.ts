import type * as vscode from 'vscode';
import type { ForgeConfig, SdcppImageBackendConfig } from '../config/types';
import { getLogger } from '../util/logger';
import { SdServerBackend, type SdServerBackendDeps } from './SdServerBackend';

/**
 * The window's `sd-server` owners: one `SdServerBackend` per configured
 * `sdcpp` backend. Built by `registerAllTools` beside the `generate_image` tool
 * that dispatches through it, and returned to `extension.ts`, which pushes it to
 * `context.subscriptions` and hands it each reloaded config — the ledger needs
 * teardown both on deactivate and on a reload that removes or edits a backend.
 */
const log = getLogger();

export class SdServerRegistry implements vscode.Disposable {
  private readonly servers = new Map<string, SdServerBackend>();
  private readonly deps: SdServerBackendDeps;
  private disposed = false;

  /**
   * `deps` reaches every backend this registry builds. Production passes nothing
   * (real spawn, `%LOCALAPPDATA%` records); a test passes `recordDir` plus fakes
   * so ledger row 1 — teardown on removal and on dispose — is checkable without
   * a process, a GPU or a port, on any OS.
   */
  constructor(config: ForgeConfig, deps: SdServerBackendDeps = {}) {
    this.deps = deps;
    this.applyForgeConfig(config);
  }

  /** The live handles, by backend name. Empty for a config with no sdcpp entry. */
  handles(): ReadonlyMap<string, SdServerBackend> {
    return this.servers;
  }

  /**
   * Reconcile against the new config: keep an unchanged backend's warm server,
   * replace one whose config changed, and stop one that was removed.
   */
  applyForgeConfig(config: ForgeConfig): void {
    if (this.disposed) return;
    const wanted = new Map<string, SdcppImageBackendConfig>();
    for (const backend of config.image_generation?.backends ?? []) {
      if (backend.provider === 'sdcpp') wanted.set(backend.name, backend);
    }
    for (const [name, existing] of [...this.servers]) {
      const next = wanted.get(name);
      if (next && sameConfig(existing.config, next)) continue;
      this.servers.delete(name);
      void this.disposeOne(name, existing);
    }
    for (const [name, backend] of wanted) {
      if (this.servers.has(name)) continue;
      if (process.platform !== 'win32') {
        // `sd-server` ownership depends on Windows process identity (pid + creation
        // time via Get-CimInstance) and a %LOCALAPPDATA% record, so this backend
        // cannot be run safely here. Refuse the backend, not the activation: the
        // tool reports the same thing when it finds no handle.
        log.warn(
          `[sdcpp] image_generation.backends.${name} was skipped: sdcpp image backends need ` +
            `Windows process identity and a %LOCALAPPDATA% owner record, so they cannot run on ` +
            `${process.platform}. Remove this backend on this machine, or use a cloud image backend.`,
        );
        continue;
      }
      this.servers.set(name, new SdServerBackend(backend, this.deps));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [name, server] of [...this.servers]) {
      this.servers.delete(name);
      void this.disposeOne(name, server);
    }
  }

  /**
   * A failed teardown leaves the child holding VRAM — exactly the case the owner
   * record exists for, since the next `start()` in any window reaps it. Reported
   * to the Forge channel rather than swallowed: `dispose()` is synchronous and
   * has no caller that could act on a rejection.
   */
  private async disposeOne(name: string, server: SdServerBackend): Promise<void> {
    try {
      await server.dispose();
    } catch (error) {
      log.error(
        `[sdcpp] Could not stop the sd-server for image_generation.backends.${name}: ` +
          `${error instanceof Error ? error.message : String(error)}. The next generate_image call, ` +
          'or a new Forge window, will reap it through its owner record.',
      );
    }
  }
}

/**
 * Every field counts, not just the spawn signature: `idle_timeout_ms` and
 * `request_timeout_ms` decide when a server may be stopped and whether another
 * window's render can still be in flight, so a server built under the old pair
 * must not keep running under the new one.
 */
function sameConfig(a: SdcppImageBackendConfig, b: SdcppImageBackendConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
