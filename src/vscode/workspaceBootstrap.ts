import * as path from 'path';
import * as vscode from 'vscode';
import {
  discoverWorkspaceRepositoryRoots,
  ensureForgeInstructionsFile,
} from '../llm/ForgeInstructionsLoader';
import { SESSION_KEY_V1 } from '../sidebar/sessionTypes';
import { getLogger } from '../util/logger';

/**
 * One-shot, idempotent workspace bootstrap on activation: the globalState →
 * workspaceState session migration (v2) and the optional FORGE.md
 * auto-create. Both run at most once per workspace; their order does not
 * matter.
 */
export async function bootstrapWorkspace(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  autoCreate?: boolean,
): Promise<void> {
  const log = getLogger();
  // Migration v2: globalState → workspaceState (sessions now per-workspace)
  if (!context.workspaceState.get<boolean>('forge.migrated.sessions.v2')) {
    await context.workspaceState.update('forge.migrated.sessions.v2', true);
    if (!context.workspaceState.get(SESSION_KEY_V1)) {
      const globalSession = context.globalState.get(SESSION_KEY_V1);
      if (globalSession) await context.workspaceState.update(SESSION_KEY_V1, globalSession);
    }
  }
  if (workspaceRoot && autoCreate) {
    const repositoryRoots = await discoverWorkspaceRepositoryRoots(workspaceRoot);
    for (const repositoryRoot of repositoryRoots) {
      const bootstrap = ensureForgeInstructionsFile(repositoryRoot);
      if (bootstrap.status === 'error') {
        const message = `Forge: could not create ${path.basename(bootstrap.path)} in ${repositoryRoot} — ${bootstrap.error.message}`;
        log.warn(message);
        void vscode.window.showWarningMessage(message);
      }
    }
  }
}
