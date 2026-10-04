import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isTerminal, type ExchangeState } from '../agentMesh/deliveryState';
import { latestStates, readEvents, type ExchangeLogPaths } from '../agentMesh/exchangeLog';
import {
  pendingVerdictArtifacts,
  retainVerdict,
  verdictArtifactPath,
  verdictEventId,
} from '../agentMesh/verdictArtifact';
import { MESH_MAINTENANCE_INTERVAL_MS } from './meshMaintenance';

export interface MeshVerdictPoll {
  start(): void;
  pollOnce(): Promise<void>;
  dispose(): void;
}

export function createMeshVerdictPoll(deps: {
  outboxDir: string;
  exchangePaths: ExchangeLogPaths;
  /** Injected only by a race test; production uses the atomic filesystem move. */
  moveVerdict?: typeof retainVerdict;
  onEvent: (event: {
    eventId?: string;
    exchangeId: string;
    from: string;
    type: string;
    state: ExchangeState;
    detail?: string;
  }) => Promise<void>;
}): MeshVerdictPoll {
  let timer: NodeJS.Timeout | undefined;
  let polling: Promise<void> | undefined;
  const pollOnce = async (): Promise<void> => {
    let names: string[];
    try {
      names = fs.readdirSync(deps.outboxDir);
    } catch {
      return;
    }
    const states = latestStates(readEvents(deps.exchangePaths.log));
    const root = path.dirname(deps.exchangePaths.log);
    for (const name of names) {
      if (!name.endsWith('.verdict.md')) continue;
      const exchangeId = name.slice(0, -'.verdict.md'.length);
      const file = path.join(deps.outboxDir, name);
      const state = states.get(exchangeId);
      if (state === undefined || isTerminal(state) || state === 'created') {
        try {
          fs.unlinkSync(file);
        } catch {
          // Another window consumed the orphan.
        }
        void vscode.window.showWarningMessage(
          `[agent mesh] ignored orphan verdict for exchange ${exchangeId}`,
        );
        continue;
      }
      try {
        (deps.moveVerdict ?? retainVerdict)(root, file, exchangeId);
      } catch {
        // Another window may have moved the same file after our directory scan.
        continue;
      }
    }
    // Includes artifacts left by a crash after the atomic rename but before
    // the terminal event. Each event has a stable id, deduplicated under the
    // exchange log's interprocess lock.
    for (const name of pendingVerdictArtifacts(root)) {
      const exchangeId = name.slice(0, -'.md'.length);
      let artifact: string;
      try {
        artifact = verdictArtifactPath(root, exchangeId);
      } catch {
        continue;
      }
      const events = readEvents(deps.exchangePaths.log);
      if (events.some((event) => event.eventId === verdictEventId(exchangeId))) continue;
      const state = latestStates(events).get(exchangeId);
      if (state === undefined || isTerminal(state) || state === 'created') {
        try {
          fs.unlinkSync(artifact);
        } catch {
          // Another window may have removed the orphan.
        }
        void vscode.window.showWarningMessage(
          `[agent mesh] ignored orphan verdict for exchange ${exchangeId}`,
        );
        continue;
      }
      await deps.onEvent({
        eventId: verdictEventId(exchangeId),
        exchangeId,
        from: 'forge',
        type: 'verdict',
        state: 'completed',
        detail: `Full verdict retained: forge.sh read-verdict <your-name> ${exchangeId}; acknowledge separately after reading.`,
      });
    }
  };
  return {
    pollOnce,
    start: () => {
      timer = setInterval(() => {
        if (polling) return;
        polling = pollOnce().finally(() => {
          polling = undefined;
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
