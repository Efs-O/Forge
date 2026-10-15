import { createContext, createElement, type ReactElement, type ReactNode } from 'react';

/**
 * Webview URI of the workspace root, or undefined until the host has sent it.
 *
 * A context rather than a prop: the only reader is a tool row several
 * components below App, and threading one string through every transcript
 * layer to reach it would touch five files that never use it.
 */
export const WorkspaceRootUriContext = createContext<string | undefined>(undefined);

/** Webview URI of Forge's screenshot directory, or undefined before handshake. */
export const ScreenshotsUriContext = createContext<string | undefined>(undefined);

/** Supplies both filesystem URI roots to transcript image components. */
export function WorkspaceUrisProvider({
  rootUri,
  screenshotsUri,
  children,
}: {
  rootUri: string | undefined;
  screenshotsUri: string | undefined;
  children: ReactNode;
}): ReactElement {
  return createElement(
    ScreenshotsUriContext.Provider,
    { value: screenshotsUri },
    createElement(WorkspaceRootUriContext.Provider, { value: rootUri }, children),
  );
}

/** Thumbnail URL for a workspace-relative, `/`-separated path. */
export function workspaceFileUri(rootUri: string, relativePath: string): string {
  const encoded = relativePath.split('/').map(encodeURIComponent).join('/');
  return `${rootUri.replace(/\/$/, '')}/${encoded}`;
}

/** Map only paths saved in Forge's screenshot tree onto its webview URI. */
export function screenshotFileUri(
  screenshotsUri: string,
  absolutePath: string,
): string | undefined {
  const normalized = absolutePath.replace(/\\/g, '/');
  if (!normalized.startsWith('/') && !/^[a-z]:\//iu.test(normalized)) return undefined;
  const marker = '/.forge/screenshots/';
  const start = normalized.toLowerCase().lastIndexOf(marker);
  if (start < 0) return undefined;
  const relativePath = normalized.slice(start + marker.length);
  const segments = relativePath.split('/');
  if (
    segments.length < 2 ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  return workspaceFileUri(screenshotsUri, relativePath);
}
