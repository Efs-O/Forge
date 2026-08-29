import * as vscode from 'vscode';
import type { HostToWebview } from './messageBridge';

export interface ToolApprovalRequestEvent {
  id: string;
  toolName: string;
  detail: string;
  dangerous: boolean;
  conversationId?: string;
}

export interface ToolApprovalResolvedEvent extends ToolApprovalRequestEvent {
  approved: boolean;
  reason: 'resolved' | 'cancelled';
}

export interface ToolApprovalSink {
  requested(event: ToolApprovalRequestEvent): void;
  resolved(event: ToolApprovalResolvedEvent): void;
}

interface PendingApproval extends ToolApprovalRequestEvent {
  id: string;
  toolName: string;
  detail: string;
  dangerous: boolean;
  conversationId?: string;
  resolve: (approved: boolean) => void;
  signal?: AbortSignal;
}

export class ToolApprovalService {
  private readonly queue: PendingApproval[] = [];
  private active: PendingApproval | null = null;
  private clankerMode = false;
  private onApprovalStart?: (conversationId: string) => void;
  private onApprovalEnd?: (conversationId: string) => void;
  private readonly sinks = new Set<ToolApprovalSink>();

  constructor(
    private readonly post: (message: HostToWebview) => void,
    private readonly getView: () => vscode.WebviewView | undefined,
  ) {}

  addSink(sink: ToolApprovalSink): { dispose(): void } {
    this.sinks.add(sink);
    return { dispose: () => this.sinks.delete(sink) };
  }

  pending(): ToolApprovalRequestEvent | undefined {
    return this.active ? this.eventOf(this.active) : undefined;
  }

  /** Register callbacks fired when an approval request is shown / resolved. */
  setApprovalLifecycle(
    onStart: (conversationId: string) => void,
    onEnd: (conversationId: string) => void,
  ): void {
    this.onApprovalStart = onStart;
    this.onApprovalEnd = onEnd;
  }

  setClankerMode(enabled: boolean): void {
    this.clankerMode = enabled;
  }

  getClankerMode(): boolean {
    return this.clankerMode;
  }

  toggleClankerMode(): boolean {
    this.clankerMode = !this.clankerMode;
    this.post({ type: 'clankerChanged', enabled: this.clankerMode });
    return this.clankerMode;
  }

  request(
    toolName: string,
    detail: string,
    dangerous = false,
    conversationId?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.clankerMode && !dangerous) return Promise.resolve(true);
    if (!this.getView() && this.sinks.size === 0) {
      return Promise.reject(
        new Error(`Forge: sidebar is unavailable for tool approval (${toolName}).`),
      );
    }
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const pending: PendingApproval = {
        id: `confirm-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        toolName,
        detail,
        dangerous,
        resolve,
        ...(conversationId ? { conversationId } : {}),
        ...(signal ? { signal } : {}),
      };
      signal?.addEventListener('abort', () => this.cancel(pending.id), { once: true });
      this.queue.push(pending);
      if (pending.conversationId) this.onApprovalStart?.(pending.conversationId);
      this.pump();
    });
  }

  resolve(id: string, approved: boolean): void {
    if (this.active?.id === id) {
      const current = this.active;
      this.active = null;
      if (current.conversationId) this.onApprovalEnd?.(current.conversationId);
      this.emitResolved(current, approved, 'resolved');
      current.resolve(approved);
      this.pump();
      return;
    }
    const index = this.queue.findIndex((item) => item.id === id);
    if (index >= 0) {
      const item = this.queue.splice(index, 1)[0];
      if (item.conversationId) this.onApprovalEnd?.(item.conversationId);
      this.emitResolved(item, approved, 'resolved');
      item.resolve(approved);
    }
  }

  cancelConversation(conversationId?: string): void {
    if (this.active && (!conversationId || this.active.conversationId === conversationId)) {
      const current = this.active;
      this.active = null;
      if (current.conversationId) this.onApprovalEnd?.(current.conversationId);
      this.emitResolved(current, false, 'cancelled');
      current.resolve(false);
    }
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const item = this.queue[index];
      if (item && (!conversationId || item.conversationId === conversationId)) {
        this.queue.splice(index, 1);
        if (item.conversationId) this.onApprovalEnd?.(item.conversationId);
        this.emitResolved(item, false, 'cancelled');
        item.resolve(false);
      }
    }
    this.pump();
  }

  private cancel(id: string): void {
    this.resolve(id, false);
  }

  private pump(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    if (next.signal?.aborted) {
      if (next.conversationId) this.onApprovalEnd?.(next.conversationId);
      this.emitResolved(next, false, 'cancelled');
      next.resolve(false);
      this.pump();
      return;
    }
    this.active = next;
    const event = this.eventOf(next);
    if (this.getView()) {
      void vscode.commands.executeCommand('workbench.view.extension.forge-sidebar');
      this.post({
        type: 'confirmRequest',
        id: next.id,
        toolName: next.toolName,
        detail: next.detail,
        ...(next.dangerous ? { isDangerous: true } : {}),
        ...(next.conversationId ? { conversationId: next.conversationId } : {}),
      });
    }
    for (const sink of this.sinks) sink.requested(event);
  }

  private eventOf(item: PendingApproval): ToolApprovalRequestEvent {
    return {
      id: item.id,
      toolName: item.toolName,
      detail: item.detail,
      dangerous: item.dangerous,
      ...(item.conversationId ? { conversationId: item.conversationId } : {}),
    };
  }

  private emitResolved(
    item: PendingApproval,
    approved: boolean,
    reason: ToolApprovalResolvedEvent['reason'],
  ): void {
    const event = { ...this.eventOf(item), approved, reason };
    // The webview is not a sink, so tell it separately: an approval settled from
    // a remote transport (or cancelled) must not leave live-looking buttons in
    // the sidebar for a decision that has already been made.
    if (this.getView()) this.post({ type: 'confirmResolved', id: item.id });
    for (const sink of this.sinks) sink.resolved(event);
  }
}
