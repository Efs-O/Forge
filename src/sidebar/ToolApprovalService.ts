import * as vscode from 'vscode';
import type { HostToWebview } from './messageBridge';

interface PendingApproval {
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

  constructor(
    private readonly post: (message: HostToWebview) => void,
    private readonly getView: () => vscode.WebviewView | undefined,
  ) {}

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
    if (!this.getView()) {
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
      this.pump();
    });
  }

  resolve(id: string, approved: boolean): void {
    if (this.active?.id === id) {
      const current = this.active;
      this.active = null;
      current.resolve(approved);
      this.pump();
      return;
    }
    const index = this.queue.findIndex((item) => item.id === id);
    if (index >= 0) this.queue.splice(index, 1)[0]?.resolve(approved);
  }

  cancelConversation(conversationId?: string): void {
    if (this.active && (!conversationId || this.active.conversationId === conversationId)) {
      const current = this.active;
      this.active = null;
      current.resolve(false);
    }
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const item = this.queue[index];
      if (item && (!conversationId || item.conversationId === conversationId)) {
        this.queue.splice(index, 1);
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
      next.resolve(false);
      this.pump();
      return;
    }
    this.active = next;
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
}
