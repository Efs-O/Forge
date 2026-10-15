import type { ForgeConfig } from '../config/types';
import { workspaceIdFor } from '../remote/RemoteWorkspaceHandoff';

/** Whether this window owns the shared scheduler and machine-wide wake task. */
export function isHomeWindow(config: ForgeConfig, workspaceId: string | undefined): boolean {
  const homeWorkspace = config.jobs?.home_workspace;
  if (homeWorkspace === undefined) return true;
  if (workspaceId === undefined) return false;
  return workspaceIdFor(homeWorkspace) === workspaceId;
}

/** Explain where a requested job will run from a non-home window. */
export function homeNote(config: ForgeConfig, workspaceId: string | undefined): string | undefined {
  const homeWorkspace = config.jobs?.home_workspace;
  if (homeWorkspace === undefined || isHomeWindow(config, workspaceId)) return undefined;
  return `Jobs run in the window for ${homeWorkspace}. This one runs there on that window's next tick, or when that folder is next opened.`;
}

/** Append the non-home explanation to a tool result using the current folder path. */
export function appendHomeNote(
  message: string,
  config: ForgeConfig,
  workspacePath: string | undefined,
): string {
  const workspaceId = workspacePath === undefined ? undefined : workspaceIdFor(workspacePath);
  const note = homeNote(config, workspaceId);
  return note ? `${message}\n\n${note}` : message;
}
