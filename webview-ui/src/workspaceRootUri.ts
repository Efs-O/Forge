import { createContext } from 'react';

/**
 * Webview URI of the workspace root, or undefined until the host has sent it.
 *
 * A context rather than a prop: the only reader is a tool row several
 * components below App, and threading one string through every transcript
 * layer to reach it would touch five files that never use it.
 */
export const WorkspaceRootUriContext = createContext<string | undefined>(undefined);

/** Thumbnail URL for a workspace-relative, `/`-separated path. */
export function workspaceFileUri(rootUri: string, relativePath: string): string {
  const encoded = relativePath.split('/').map(encodeURIComponent).join('/');
  return `${rootUri.replace(/\/$/, '')}/${encoded}`;
}
