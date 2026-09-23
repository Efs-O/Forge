import * as vscode from 'vscode';
import type { SidebarProviderEvents } from './providerEvents';
import type { ToolApprovalSink } from './ToolApprovalService';
import type { UserQuestionSink } from './UserQuestionService';

export const HIDDEN_TURN_ALERT_MS = 60_000;

export interface HiddenChatAlertDeps {
  events: SidebarProviderEvents;
  addApprovalSink(sink: ToolApprovalSink): { dispose(): void };
  addQuestionSink(sink: UserQuestionSink): { dispose(): void };
  activeConversationId(): string;
  view(): vscode.WebviewView | undefined;
  switchConversation(id: string): void;
}

/** VS Code notifications for requests and outcomes belonging to off-screen chats. */
export class HiddenChatAlerts implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly waiting = new Map<string, string>();
  private readonly started = new Map<string, number>();

  constructor(private readonly deps: HiddenChatAlertDeps) {
    this.disposables.push(
      deps.addApprovalSink({
        requested: (event) =>
          this.notify('Forge is waiting for tool approval.', event.conversationId),
        resolved: (event) => this.resolve(event.conversationId),
      }),
    );
    this.disposables.push(
      deps.addQuestionSink({
        asked: (event) => this.notify('Forge is waiting for your answer.', event.conversationId),
        answered: (event) => this.resolve(event.conversationId),
      }),
    );
    const { onGenerationStarted, onGenerationFinished, onTurnFailed } = deps.events;
    deps.events.onGenerationStarted = (model, id) => {
      onGenerationStarted?.(model, id);
      if (id) this.started.set(id, Date.now());
    };
    deps.events.onGenerationFinished = (model, id, text) => {
      onGenerationFinished?.(model, id, text);
      const startedAt = id ? this.started.get(id) : undefined;
      if (id) this.started.delete(id);
      if (startedAt !== undefined && Date.now() - startedAt >= HIDDEN_TURN_ALERT_MS) {
        this.notify('A Forge chat finished a long-running turn.', id);
      }
    };
    deps.events.onTurnFailed = (id, message) => {
      onTurnFailed?.(id, message);
      this.notify(id ? `Forge chat failed: ${message}` : `Forge turn failed: ${message}`, id);
    };
  }

  /** Clear waiting notices once the chat is visible on screen. */
  seen(): void {
    if (!this.deps.view()?.visible) return;
    this.resolve(this.deps.activeConversationId());
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.waiting.clear();
    this.started.clear();
  }

  private notify(message: string, conversationId?: string): void {
    if (conversationId && this.isOnScreen(conversationId)) return;
    const key = conversationId ?? 'unattributed';
    if (this.waiting.has(key)) return;
    this.waiting.set(key, message);
    const actions = conversationId ? ['Open chat'] : [];
    void vscode.window.showInformationMessage(message, ...actions).then((action) => {
      if (action !== 'Open chat' || !conversationId) return;
      void vscode.commands.executeCommand('workbench.view.extension.forge-sidebar').then(() => {
        this.deps.switchConversation(conversationId);
      });
    });
  }

  private resolve(conversationId?: string): void {
    if (conversationId) this.waiting.delete(conversationId);
    else this.waiting.delete('unattributed');
  }

  private isOnScreen(conversationId: string): boolean {
    return (
      this.deps.view()?.visible === true && this.deps.activeConversationId() === conversationId
    );
  }
}
