import * as vscode from 'vscode';
import type { SidebarProviderEvents } from './providerEvents';
import type { ToolApprovalRequestEvent, ToolApprovalSink } from './ToolApprovalService';
import type { UserQuestionSink } from './UserQuestionService';
import { displayTitle } from './conversationTitle';

const HIDDEN_TURN_ALERT_MS = 60_000;

export interface HiddenChatAlertDeps {
  events: SidebarProviderEvents;
  addApprovalSink(sink: ToolApprovalSink): { dispose(): void };
  addQuestionSink(sink: UserQuestionSink): { dispose(): void };
  /** Active chat plus open chats' titles, so an alert can say WHICH chat. */
  sidebar(): {
    activeConversationId: string;
    conversations: readonly { id: string; title: string }[];
  };
  view(): vscode.WebviewView | undefined;
  switchConversation(id: string): void;
  /** Whether this window is the one the owner is typing in. `WebviewView.visible`
   *  says a view is part of the layout, not that anyone can see it: a card raised
   *  while the owner sits in another window or another program is a card nobody
   *  saw, and treating it as seen is how a blocking approval goes unnoticed. */
  windowFocused(): boolean;
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
          this.notify('is waiting for tool approval.', event.conversationId, true),
        resolved: (event) => this.resolve(event.conversationId),
        waitingForOwner: (event) => this.announceWaitingForOwner(event),
      }),
    );
    this.disposables.push(
      deps.addQuestionSink({
        asked: (event) => this.notify('is waiting for your answer.', event.conversationId, true),
        answered: (event) => this.resolve(event.conversationId),
      }),
    );
    const { onGenerationStarted, onGenerationFinished, onTurnFailed } = deps.events;
    deps.events.onGenerationStarted = (model, id) => {
      onGenerationStarted?.(model, id);
      if (id) this.started.set(id, Date.now());
    };
    deps.events.onGenerationFinished = (model, id, text, outcome) => {
      onGenerationFinished?.(model, id, text, outcome);
      const startedAt = id ? this.started.get(id) : undefined;
      if (id) this.started.delete(id);
      if (startedAt !== undefined && Date.now() - startedAt >= HIDDEN_TURN_ALERT_MS) {
        this.notify('finished a long-running turn.', id);
      }
    };
    deps.events.onTurnFailed = (id, message) => {
      onTurnFailed?.(id, message);
      this.notify(`failed: ${message}`, id);
    };
    this.disposables.push({
      dispose: () => {
        if (onGenerationStarted) deps.events.onGenerationStarted = onGenerationStarted;
        else delete deps.events.onGenerationStarted;
        if (onGenerationFinished) deps.events.onGenerationFinished = onGenerationFinished;
        else delete deps.events.onGenerationFinished;
        if (onTurnFailed) deps.events.onTurnFailed = onTurnFailed;
        else delete deps.events.onTurnFailed;
      },
    });
  }

  /** Clear waiting notices once the chat is visible on screen. */
  seen(): void {
    if (!this.deps.view()?.visible) return;
    this.resolve(this.deps.sidebar().activeConversationId);
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.waiting.clear();
    this.started.clear();
  }

  /**
   * `waiting` marks a request that blocks the chat (approval, ask_user): one alert
   * per chat until it resolves. Finish and failure alerts are one-shot and never
   * tracked, so they cannot silence a later request from the same chat.
   */
  private notify(what: string, conversationId?: string, waiting = false): void {
    if (conversationId && this.isOnScreen(conversationId)) return;
    const message = `${this.subject(conversationId)} ${what}`;
    if (waiting) {
      const key = conversationId ?? 'unattributed';
      // A request that blocks a chat the owner cannot see has to be answered in
      // that chat, so the window goes to it: the sidebar comes forward showing
      // THAT chat, not whichever one was last on screen.
      if (conversationId) this.reveal(conversationId);
      if (this.waiting.has(key)) return;
      this.waiting.set(key, message);
    }
    const actions = conversationId ? ['Open chat'] : [];
    void vscode.window.showInformationMessage(message, ...actions).then((action) => {
      if (action !== 'Open chat' || !conversationId) return;
      this.reveal(conversationId);
    });
  }

  /** Bring the sidebar forward and show THIS chat in it, in that order: a reveal
   *  that leaves another chat on screen shows the owner a chat they did not ask
   *  about, and the card or question they have to answer is nowhere in it. */
  private reveal(conversationId: string): void {
    void vscode.commands.executeCommand('workbench.view.extension.forge-sidebar').then(() => {
      this.deps.switchConversation(conversationId);
    });
  }

  /**
   * A card only the owner can answer: the gate is one no automated answer is
   * allowed for. A warning with a Show button, not the ordinary "waiting for
   * approval" notice, because the chat is now stopped on a person rather than on
   * a gate, and the owner has to be able to find it from another chat or another
   * file.
   */
  private announceWaitingForOwner(event: ToolApprovalRequestEvent): void {
    const conversationId = event.conversationId;
    if (conversationId && this.isOnScreen(conversationId)) return;
    const target = event.detail.split('\n')[0]?.slice(0, 120) ?? '';
    const message = `${this.subject(conversationId)} needs your approval: ${event.toolName} ${target}`;
    void vscode.window.showWarningMessage(message, 'Show').then((action) => {
      if (action !== 'Show' || !conversationId) return;
      this.reveal(conversationId);
    });
  }

  private subject(conversationId?: string): string {
    if (!conversationId) return 'Forge';
    const chat = this.deps.sidebar().conversations.find((c) => c.id === conversationId);
    return chat ? `Forge chat "${displayTitle(chat.title)}"` : 'A Forge chat';
  }

  private resolve(conversationId?: string): void {
    if (conversationId) this.waiting.delete(conversationId);
    else this.waiting.delete('unattributed');
  }

  private isOnScreen(conversationId: string): boolean {
    return (
      this.deps.view()?.visible === true &&
      this.deps.windowFocused() &&
      this.deps.sidebar().activeConversationId === conversationId
    );
  }
}
