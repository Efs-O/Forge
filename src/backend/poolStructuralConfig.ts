/**
 * Which config settings are baked into the pool's physical slot layout, and
 * what a hot reload is allowed to do with them.
 *
 * `BackendPool.freePorts` is built once, in the constructor. If a reload could
 * change the settings it was derived from, capacity policy
 * (`DelegationGate.maxSlots`) would read a layout the slot table does not
 * implement. A warning alone does not close that gap, so these values are
 * pinned to their construction-time snapshot and the user is told that a
 * window reload is required.
 *
 * Split out of `BackendPool`, which keeps slot allocation and lifecycle.
 */

import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import { getLogger } from '../util/logger';

const log = getLogger();

/** Settings the physical slot/port inventory was constructed from. */
export interface StructuralSettings {
  maxSimultaneousModels: number;
  port: number;
  shared: boolean;
}

export function readStructuralSettings(config: ForgeConfig): StructuralSettings {
  return {
    maxSimultaneousModels: config.max_simultaneous_models ?? 1,
    port: config.llama_server.port ?? 8080,
    shared: config.shared_runtime?.enabled === true,
  };
}

/** Names of the structural settings `next` would change. Empty when a reload
 *  can be applied wholesale. */
export function changedStructuralSettings(active: StructuralSettings, next: ForgeConfig): string[] {
  const incoming = readStructuralSettings(next);
  const changed: string[] = [];
  if (incoming.maxSimultaneousModels !== active.maxSimultaneousModels) {
    changed.push('max_simultaneous_models');
  }
  if (incoming.port !== active.port) changed.push('llama_server.port');
  if (incoming.shared !== active.shared) changed.push('shared_runtime.enabled');
  return changed;
}

/** `next` with the structural settings carried forward from `active`, so no
 *  runtime reader can see a value the physical pool does not implement. */
export function withPinnedStructuralSettings(
  active: StructuralSettings,
  next: ForgeConfig,
): ForgeConfig {
  return {
    ...next,
    max_simultaneous_models: active.maxSimultaneousModels,
    llama_server: { ...next.llama_server, port: active.port },
    ...(next.shared_runtime
      ? { shared_runtime: { ...next.shared_runtime, enabled: active.shared } }
      : {}),
  };
}

/** Tell the user their change was parsed but is not active yet. Per the
 *  no-silent-fallback rule this reaches the UI, not just the log. */
export function warnStructuralReloadRequired(changed: string[]): void {
  const subject = changed.length > 1 ? 'these settings' : 'this setting';
  const message =
    `Forge: ${changed.join(', ')} changed, but ${subject} define the backend slot ` +
    'layout created at startup. The old value stays active until you reload the window.';
  log.warn(`[BackendPool] ${message}`);
  void vscode.window.showWarningMessage(message);
}
