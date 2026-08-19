import type { HostToWebview, WebviewDiagnosticMsg } from '../../src/sidebar/messageBridge';
import { vscode } from './vscode';

const MAX_RECENT = 200;
const MAX_ERROR_TEXT = 4_000;
const HEARTBEAT_MS = 60_000;
const INPUT_SAMPLE_MS = 500;
const STREAM_TYPES = new Set<HostToWebview['type']>(['token', 'reasoningToken']);

interface ViewStateSnapshot {
  activeConversationId: string;
  displayedMessages: number;
  queuedPrompts: number;
  streaming: boolean;
  prefillPending: boolean;
}

type DiagnosticPost = (message: WebviewDiagnosticMsg) => void;

export class WebviewDiagnostics {
  readonly instanceId = makeInstanceId();
  private readonly startedAt = Date.now();
  private readonly recent: WebviewDiagnosticMsg['recent'] = [];
  private readonly messageTypes: Record<string, number> = {};
  private hostMessages = 0;
  private renders = 0;
  private inputChanges = 0;
  private lastInputSample = 0;
  private heartbeat: number | undefined;
  private state: ViewStateSnapshot = {
    activeConversationId: '',
    displayedMessages: 0,
    queuedPrompts: 0,
    streaming: false,
    prefillPending: false,
  };

  constructor(private readonly post: DiagnosticPost = (message) => vscode.postMessage(message)) {}

  start(): () => void {
    this.addBreadcrumb('lifecycle:mount');
    this.send('mount');
    const onError = (event: ErrorEvent): void => {
      this.capture('error', event.error ?? event.message);
    };
    const onRejection = (event: PromiseRejectionEvent): void => {
      this.capture('unhandledrejection', event.reason);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    this.heartbeat = window.setInterval(() => this.send('heartbeat'), HEARTBEAT_MS);
    return () => {
      if (this.heartbeat !== undefined) window.clearInterval(this.heartbeat);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      this.addBreadcrumb('lifecycle:unmount');
      this.send('unmount');
    };
  }

  recordRender(): void {
    this.renders += 1;
  }

  recordHostMessage(message: HostToWebview): void {
    this.hostMessages += 1;
    this.messageTypes[message.type] = (this.messageTypes[message.type] ?? 0) + 1;
    if (STREAM_TYPES.has(message.type)) return;
    this.addBreadcrumb(`host:${message.type}`, conversationIdOf(message), messageDetail(message));
  }

  recordInputChange(length: number): void {
    this.inputChanges += 1;
    const now = Date.now();
    if (now - this.lastInputSample < INPUT_SAMPLE_MS) return;
    this.lastInputSample = now;
    this.addBreadcrumb('input:change', undefined, `length=${length}`);
  }

  recordState(state: ViewStateSnapshot): void {
    if (sameState(this.state, state)) return;
    this.state = { ...state };
    this.addBreadcrumb(
      'react:state',
      state.activeConversationId,
      `messages=${state.displayedMessages} queued=${state.queuedPrompts} streaming=${state.streaming} prefill=${state.prefillPending}`,
    );
  }

  capture(
    kind: 'error' | 'unhandledrejection' | 'react-error',
    error: unknown,
    componentStack?: string,
  ): void {
    const normalized = normalizeError(error);
    this.addBreadcrumb(`crash:${kind}`, this.state.activeConversationId, normalized.message);
    this.send(kind, {
      message: normalized.message,
      ...(normalized.stack ? { stack: normalized.stack } : {}),
      ...(componentStack ? { componentStack: clamp(componentStack) } : {}),
      recent: [...(this.recent ?? [])],
    });
  }

  private addBreadcrumb(event: string, conversationId?: string, detail?: string): void {
    const breadcrumb = {
      timestamp: Date.now(),
      event,
      ...(conversationId ? { conversationId } : {}),
      ...(detail ? { detail: clamp(detail, 500) } : {}),
    };
    this.recent?.push(breadcrumb);
    if ((this.recent?.length ?? 0) > MAX_RECENT) this.recent?.shift();
  }

  private send(
    kind: WebviewDiagnosticMsg['kind'],
    extra: Partial<
      Pick<WebviewDiagnosticMsg, 'message' | 'stack' | 'componentStack' | 'recent'>
    > = {},
  ): void {
    try {
      this.post({
        type: 'webviewDiagnostic',
        instanceId: this.instanceId,
        kind,
        timestamp: Date.now(),
        summary: {
          uptimeMs: Date.now() - this.startedAt,
          hostMessages: this.hostMessages,
          messageTypes: { ...this.messageTypes },
          renders: this.renders,
          inputChanges: this.inputChanges,
          ...this.state,
        },
        ...extra,
      });
    } catch {
      // The bridge can already be gone during webview teardown.
    }
  }
}

function makeInstanceId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `wv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function clamp(value: string, max = MAX_ERROR_TEXT): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function normalizeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: clamp(error.message || error.name),
      ...(error.stack ? { stack: clamp(error.stack) } : {}),
    };
  }
  return { message: clamp(String(error)) };
}

function conversationIdOf(message: HostToWebview): string | undefined {
  if ('conversationId' in message && typeof message.conversationId === 'string') {
    return message.conversationId;
  }
  return message.type === 'sessionSync' ? message.activeId : undefined;
}

function messageDetail(message: HostToWebview): string | undefined {
  switch (message.type) {
    case 'sessionSync':
      return `tabs=${message.tabs.length} history=${message.history.length} conversations=${Object.keys(message.messagesById).length}`;
    case 'toolResult':
      return `tool=${message.toolName} chars=${message.totalChars} error=${Boolean(message.isError)}`;
    case 'setInput':
      return `length=${message.text.length}`;
    default:
      return undefined;
  }
}

function sameState(a: ViewStateSnapshot, b: ViewStateSnapshot): boolean {
  return (
    a.activeConversationId === b.activeConversationId &&
    a.displayedMessages === b.displayedMessages &&
    a.queuedPrompts === b.queuedPrompts &&
    a.streaming === b.streaming &&
    a.prefillPending === b.prefillPending
  );
}

export const webviewDiagnostics = new WebviewDiagnostics();
