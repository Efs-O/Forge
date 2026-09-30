import {
  groupByExchange,
  latestStates,
  readEvents,
  compact,
  type ExchangeLogPaths,
} from '../agentMesh/exchangeLog';
import {
  listOwnedAliases,
  readOwnership,
  recoverOwnership,
  writeOwnership,
} from '../agentMesh/ownership';
import type { MeshSessionProvider } from '../agentMesh/sessionProvider';
import type { TurnStatus } from '../agentMesh/turnStatus';
import type { ExchangeState } from '../agentMesh/deliveryState';

export const MESH_MAINTENANCE_INTERVAL_MS = 60_000;
const IDLE_TTL_MS = 2 * 60 * 60_000;

export interface MeshMaintenance {
  start(): void;
  dispose(): void;
}

export interface MeshMaintenanceDeps {
  root: string;
  exchangePaths: ExchangeLogPaths;
  provider: MeshSessionProvider;
  turnStatus: TurnStatus;
  onEvent: (event: {
    exchangeId: string;
    from: string;
    to?: string;
    type: string;
    state: ExchangeState;
    detail?: string;
  }) => Promise<void>;
}

export function createMeshMaintenance(deps: MeshMaintenanceDeps): MeshMaintenance {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const recover = async (): Promise<void> => {
    try {
      const recovery = recoverOwnership(deps.root);
      for (const action of recovery.actions) {
        if (action.action !== 'reaped') continue;
        await deps.provider.reap(action.alias);
        await deps.onEvent({
          exchangeId: `crash-${action.alias}`,
          from: 'forge',
          to: action.alias,
          type: 'notice',
          state: 'crashed',
          detail: 'owned session lost; thread kept for resume',
        });
        const events = readEvents(deps.exchangePaths.log);
        const states = latestStates(events);
        for (const [exchangeId, exchangeEvents] of groupByExchange(events)) {
          if (states.get(exchangeId) !== 'accepted') continue;
          if (!exchangeEvents.some((event) => event.to?.toLowerCase() === action.alias)) continue;
          await deps.onEvent({
            exchangeId,
            from: 'forge',
            to: action.alias,
            type: 'state',
            state: 'timeout',
            detail: 'owner host died before the queued message started',
          });
        }
      }
    } catch {
      // Recovery is best-effort; a failure here must not block activation.
    } finally {
      deps.turnStatus.sweepDead();
    }
  };
  const run = async (): Promise<void> => {
    try {
      await compact(deps.exchangePaths, {}, {});
      for (const alias of listOwnedAliases(deps.root)) {
        const record = readOwnership(deps.root, alias);
        if (!record || record.parked || !deps.provider.isOwner(alias)) continue;
        const last = record.last_activity ?? record.created_at;
        if (Date.now() - last <= IDLE_TTL_MS) continue;
        await deps.provider.reap(alias);
        writeOwnership(deps.root, { ...record, owner_host: null, parked: false });
        await deps.onEvent({
          exchangeId: `idle-${alias}`,
          from: 'forge',
          to: alias,
          type: 'notice',
          state: 'timeout',
          detail: 'idle TTL reached; session reaped, thread kept for resume',
        });
      }
    } catch {
      // Maintenance is best-effort; a failure must not crash the host.
    }
  };
  return {
    start: () => {
      void recover();
      timer = setInterval(() => {
        if (running) return;
        running = run().finally(() => {
          running = undefined;
        });
      }, MESH_MAINTENANCE_INTERVAL_MS);
      timer.unref?.();
    },
    dispose: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
