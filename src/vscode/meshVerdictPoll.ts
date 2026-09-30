import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isTerminal, type ExchangeState } from '../agentMesh/deliveryState';
import { latestStates, readEvents, type ExchangeLogPaths } from '../agentMesh/exchangeLog';
import { MESH_MAINTENANCE_INTERVAL_MS } from './meshMaintenance';

export interface MeshVerdictPoll {
  start(): void;
  dispose(): void;
}

export function createMeshVerdictPoll(deps: {
  outboxDir: string;
  exchangePaths: ExchangeLogPaths;
  onEvent: (event: {
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
      let body = '';
      try {
        body = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      await deps.onEvent({
        exchangeId,
        from: 'forge',
        type: 'verdict',
        state: 'completed',
        detail: body.slice(0, 500),
      });
      try {
        fs.unlinkSync(file);
      } catch {
        // Another window consumed it.
      }
    }
  };
  return {
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
