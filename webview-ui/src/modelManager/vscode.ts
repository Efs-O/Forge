import type {
  ModelManagerHostToPanel,
  ModelManagerPanelToHost,
} from '../../../src/sidebar/modelManager/messages';

declare function acquireVsCodeApi(): {
  postMessage(msg: ModelManagerPanelToHost): void;
};

// Called once per webview lifetime — this panel is a separate webview from
// the sidebar chat view, so this is a distinct acquireVsCodeApi() call.
export const vscode = acquireVsCodeApi();

export type PanelMessage = ModelManagerHostToPanel;
