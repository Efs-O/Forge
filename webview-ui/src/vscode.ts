import type { HostToWebview, WebviewToHost } from '../../src/sidebar/messageBridge';

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewToHost): void;
};

// Called once — VS Code throws if called more than once per webview lifetime.
export const vscode = acquireVsCodeApi();

export type WebviewMessage = HostToWebview;
