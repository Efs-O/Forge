/**
 * Webview-side failures, relayed to the host log.
 *
 * Split out of `SidebarProvider`. The webview is a separate JS context: when it
 * throws, nothing reaches the extension host log unless the webview reports it,
 * and a React error boundary firing there is otherwise invisible. Errors carry
 * every trace we have — stack, component stack, recent messages — because the
 * report is the only forensic record of a crash the user just saw.
 */

import type { WebviewDiagnosticMsg } from './messageBridge';
import { getLogger } from '../util/logger';

const log = getLogger();

const FAILURE_KINDS = new Set(['error', 'unhandledrejection', 'react-error']);

export function logWebviewDiagnostic(message: WebviewDiagnosticMsg): void {
  const prefix = `[webview:${message.instanceId}] ${message.kind}`;
  const summary = JSON.stringify(message.summary);
  if (!FAILURE_KINDS.has(message.kind)) {
    log.info(`${prefix} summary=${summary}`);
    return;
  }
  log.error(`${prefix} message=${message.message ?? 'unknown'} summary=${summary}`);
  if (message.stack) log.error(`${prefix} stack=${message.stack}`);
  if (message.componentStack) log.error(`${prefix} component=${message.componentStack}`);
  if (message.recent) log.error(`${prefix} recent=${JSON.stringify(message.recent)}`);
}
