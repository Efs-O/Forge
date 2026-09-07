/**
 * The webview's self-report: what it is doing, and how it failed.
 *
 * Split from `messageBridge` on subject, not on size. Every other message there
 * is chat protocol — prompts, tokens, tool rows; these are instrumentation
 * about the React context itself, consumed by `webviewDiagnostics.ts` and by
 * nothing that renders a conversation. `messageBridge` re-exports them, so the
 * single typed bridge stays the one import every surface reaches for.
 */

export type WebviewDiagnosticKind =
  | 'mount'
  | 'unmount'
  | 'heartbeat'
  | 'error'
  | 'unhandledrejection'
  | 'react-error';

export interface WebviewDiagnosticBreadcrumb {
  timestamp: number;
  event: string;
  conversationId?: string;
  detail?: string;
}

export interface WebviewDiagnosticSummary {
  uptimeMs: number;
  hostMessages: number;
  messageTypes: Record<string, number>;
  renders: number;
  inputChanges: number;
  activeConversationId: string;
  displayedMessages: number;
  queuedPrompts: number;
  streaming: boolean;
  prefillPending: boolean;
}

/** Bounded, content-free diagnostics from the isolated React webview. */
export interface WebviewDiagnosticMsg {
  type: 'webviewDiagnostic';
  instanceId: string;
  kind: WebviewDiagnosticKind;
  timestamp: number;
  summary: WebviewDiagnosticSummary;
  message?: string;
  stack?: string;
  componentStack?: string;
  recent?: WebviewDiagnosticBreadcrumb[];
}
