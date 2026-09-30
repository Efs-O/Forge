import { projectBoard, projectLiveSessions } from '../agentMesh/boardView';

export interface MeshObservationDeps {
  scope: () => { workspace: string; conversation?: string };
  logPath: string;
  root: string;
  aliases: () => string[];
  queueLength: (alias: string) => number;
}

export function renderMeshObservation(
  verb: 'status' | 'board' | 'peers' | 'queue' | 'context',
  deps: MeshObservationDeps,
): string {
  const scope = deps.scope();
  switch (verb) {
    case 'status':
    case 'board': {
      const rows = projectBoard(deps.logPath, scope.workspace, scope.conversation, 5);
      const sessions = projectLiveSessions(deps.root);
      const board = rows
        .map(
          (row) =>
            `${row.from}→${row.to ?? '?'}: ${row.label}${row.detail ? ` (${row.detail})` : ''}`,
        )
        .join('; ');
      const live = sessions.map((session) => `${session.alias}[${session.state}]`).join(', ');
      return `board: ${board || 'empty'}\nlive: ${live || 'none'}`;
    }
    case 'peers': {
      const sessions = projectLiveSessions(deps.root);
      return `peers: ${sessions.map((session) => `${session.alias}[${session.state}]`).join(', ') || 'none'}`;
    }
    case 'queue': {
      const pending = deps
        .aliases()
        .filter((alias) => alias !== 'forge')
        .map((alias) => ({ alias, count: deps.queueLength(alias) }))
        .filter(({ count }) => count > 0)
        .map(({ alias, count }) => `${alias}: ${count}`);
      return `queue: ${pending.join(', ') || 'empty'}`;
    }
    case 'context':
      return `context: workspace=${scope.workspace}${scope.conversation ? ` conversation=${scope.conversation}` : ' (unbound)'}`;
  }
}
