import type { ForgeConfig } from '../config/types';
import type { CodexAppServerSession } from '../agents/CodexAppServerSession';
import { queueToCodex } from '../agentBus/codexDelivery';
import { resolveSessionIdentity } from './aliasRegistry';
import { CodexOwnedAdapter, CodexQueueAdapter } from './adapters';
import type { MeshAdapter } from './meshAdapter';
import { CodexDiscovery } from './codexDiscovery';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';

/**
 * F-05: is a Codex config pin a LIVE user-opened thread?
 *
 * A pin with no alias is only a valid non-observing identity when its thread
 * is actually live on the app-server; a dead UUID in `agent_bus.codex_thread`
 * is not — it would pass sender validation and let `tell` record an accepted
 * exchange against a thread no live session owns. This discovers the live
 * threads and checks the pin against them. A discovery failure (no app-server,
 * hung, etc.) means the pin cannot be proven live, so it is treated as absent:
 * the caller returns no adapter and `tell` refuses rather than queueing against
 * a ghost thread.
 *
 * Kept out of sessionProvider.ts (which is at the 500-line lint limit) — it is
 * a self-contained liveness probe with its own discovery + CLI-resolution
 * dependencies.
 */
export async function codexPinIsLive(
  pin: string,
  opts: { codexCli?: string; cwd: string; timeoutMs?: number },
): Promise<boolean> {
  try {
    const executable = await resolveCliExecutable(opts.codexCli ?? 'codex', 'codex');
    const discovery = new CodexDiscovery({
      executable,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? 8_000,
    });
    const { threads } = await discovery.discover();
    return threads.some((t) => t.id === pin);
  } catch {
    return false;
  }
}

/** The context a non-observing Codex adapter needs (extracted from the provider). */
export interface CodexPinContext {
  /** The owned Codex session this window holds, if any. */
  ownedCodex: CodexAppServerSession | undefined;
  getConfig: () => ForgeConfig;
  busRoot: string;
  queueCodex?: (
    cli: string,
    thread: string,
    message: string,
    signal?: AbortSignal,
  ) => Promise<void>;
}

/**
 * The non-observing queue adapter for a user-opened Codex pin (the sync
 * fallback the orchestrator uses when no owned session can be resolved).
 * Moved out of sessionProvider.ts to keep it under the 500-line limit.
 */
export function codexQueueAdapter(ctx: CodexPinContext): MeshAdapter | undefined {
  if (ctx.ownedCodex) {
    return new CodexOwnedAdapter(ctx.ownedCodex);
  }
  const bus = ctx.getConfig().agent_bus;
  const identity = resolveSessionIdentity(ctx.busRoot, 'codex', bus?.codex_thread);
  if (identity && !identity.fromAlias) {
    return new CodexQueueAdapter(
      bus?.codex_cli ?? 'codex',
      identity.session_id,
      ctx.queueCodex ?? queueToCodex,
    );
  }
  return undefined;
}

/**
 * The non-observing queue adapter, but only when the config pin is a LIVE
 * thread (F-05). A dead UUID in `agent_bus.codex_thread` is not a live
 * identity: returning no adapter makes `tell` refuse rather than record an
 * accepted exchange against a ghost thread.
 */
export async function codexQueueAdapterIfLive(
  ctx: CodexPinContext,
): Promise<MeshAdapter | undefined> {
  const bus = ctx.getConfig().agent_bus;
  const pin = bus?.codex_thread;
  const identity = resolveSessionIdentity(ctx.busRoot, 'codex', pin);
  if (!identity || identity.fromAlias) return codexQueueAdapter(ctx);
  const codexCli = bus?.codex_cli;
  const live = await codexPinIsLive(identity.session_id, {
    ...(codexCli ? { codexCli } : {}),
    cwd: process.cwd(),
  });
  return live ? codexQueueAdapter(ctx) : undefined;
}
