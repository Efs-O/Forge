import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HiddenChatAlerts } from '../../src/sidebar/hiddenChatAlerts';

afterEach(() => vi.restoreAllMocks());

function fixture(onFinished?: NonNullable<ReturnType<typeof makeEvents>['onGenerationFinished']>) {
  let approval:
    | {
        requested: (event: { conversationId?: string }) => void;
        resolved: (event: { conversationId?: string }) => void;
        waitingForOwner?: (event: {
          id: string;
          toolName: string;
          detail: string;
          dangerous: boolean;
          conversationId?: string;
        }) => void;
      }
    | undefined;
  let question:
    | {
        asked: (event: { conversationId?: string }) => void;
        answered: (event: { conversationId?: string }) => void;
      }
    | undefined;
  const events: {
    onGenerationStarted?: (model: string | null, id?: string) => void;
    onGenerationFinished?: (
      model: string | null,
      id: string | undefined,
      text: string | undefined,
      outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted',
    ) => void;
    onTurnFailed?: (id: string | undefined, message: string) => void;
  } = onFinished ? { onGenerationFinished: onFinished } : {};
  let active = 'visible';
  let visible = true;
  let focused = true;
  const switchChat = vi.fn();
  const alerts = new HiddenChatAlerts({
    events,
    addApprovalSink: (sink) => {
      approval = sink;
      return { dispose: vi.fn() };
    },
    addQuestionSink: (sink) => {
      question = sink;
      return { dispose: vi.fn() };
    },
    sidebar: () => ({
      activeConversationId: active,
      conversations: [{ id: 'background', title: 'Fix the lease' }],
    }),
    view: () => ({ visible }) as vscode.WebviewView,
    switchConversation: switchChat,
    windowFocused: () => focused,
  });
  return {
    alerts,
    events,
    switchChat,
    approval: () => approval!,
    question: () => question!,
    setActive: (id: string) => {
      active = id;
    },
    setVisible: (value: boolean) => {
      visible = value;
    },
    setFocused: (value: boolean) => {
      focused = value;
    },
  };
}

function makeEvents() {
  return {
    onGenerationFinished: (
      _model: string | null,
      _id: string | undefined,
      _text: string | undefined,
      _outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted',
    ) => {},
  };
}

describe('HiddenChatAlerts', () => {
  it('alerts for hidden approvals and questions, then allows a later request after resolution', () => {
    const state = fixture();
    const toast = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    state.approval().requested({ conversationId: 'background' });
    state.approval().requested({ conversationId: 'background' });
    expect(toast).toHaveBeenCalledOnce();
    state.approval().resolved({ conversationId: 'background' });
    state.question().asked({ conversationId: 'background' });
    expect(toast).toHaveBeenCalledTimes(2);
    state.alerts.dispose();
  });

  it('a finish or failure alert does not silence a later approval from the same chat', () => {
    const state = fixture();
    const toast = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    state.events.onGenerationStarted?.('model', 'background');
    now.mockReturnValue(70_000);
    state.events.onGenerationFinished?.('model', 'background', undefined, 'completed');
    state.events.onTurnFailed?.('background', 'backend stopped');
    state.approval().requested({ conversationId: 'background' });
    expect(toast).toHaveBeenCalledTimes(3);
    state.alerts.dispose();
  });

  it('alerts for an unattributed failure and for a hidden turn lasting at least a minute', () => {
    const state = fixture();
    state.setVisible(false);
    const toast = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    state.events.onGenerationStarted?.('model', 'long');
    now.mockReturnValue(70_000);
    state.events.onGenerationFinished?.('model', 'long', undefined, 'completed');
    state.events.onTurnFailed?.(undefined, 'backend stopped');
    expect(toast).toHaveBeenCalledTimes(2);
    state.alerts.dispose();
  });

  /** The measured incident (chat 14cd7203, 2026-11-24): a dangerous card opened
   *  in a chat the owner was not looking at and was answered 1.3 s later with no
   *  owner action. `WebviewView.visible` was true and the chat was the active tab,
   *  so the old rule called the card seen — in another window, or another program,
   *  nobody had seen anything. */
  it('alerts for the active visible chat while the window itself is not focused', () => {
    const state = fixture();
    const toast = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    state.approval().requested({ conversationId: 'visible' });
    expect(toast).not.toHaveBeenCalled();
    state.setFocused(false);
    state.approval().requested({ conversationId: 'visible' });
    expect(toast).toHaveBeenCalledOnce();
    state.alerts.dispose();
  });

  it('warns for an owner-only card in an unfocused window too', () => {
    const state = fixture();
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    state.setActive('background');
    state.setFocused(false);
    state
      .approval()
      .waitingForOwner?.({
        id: 'gate-1',
        toolName: 'shell',
        detail: 'rm -rf the build folder',
        dangerous: true,
        conversationId: 'background',
      });
    expect(warn).toHaveBeenCalledOnce();
    state.alerts.dispose();
  });

  it('suppresses the active visible chat and alerts when that same view is hidden', () => {
    const state = fixture();
    const toast = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    state.approval().requested({ conversationId: 'visible' });
    expect(toast).not.toHaveBeenCalled();
    state.setVisible(false);
    state.question().asked({ conversationId: 'visible' });
    expect(toast).toHaveBeenCalledOnce();
    state.alerts.dispose();
  });

  it('clears an alert when its chat is seen, and offers Open chat for attributed alerts', async () => {
    const state = fixture();
    state.setVisible(false);
    const toast = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Open chat');
    const command = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    state.approval().requested({ conversationId: 'background' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(command).toHaveBeenCalledWith('workbench.view.extension.forge-sidebar');
    expect(state.switchChat).toHaveBeenCalledWith('background');
    state.setVisible(true);
    state.setActive('background');
    state.alerts.seen();
    state.setVisible(false);
    state.approval().requested({ conversationId: 'background' });
    expect(toast).toHaveBeenCalledTimes(2);
    state.alerts.dispose();
  });

  it('forwards the generation outcome unchanged to the wrapped hook', () => {
    const inner = vi.fn();
    const state = fixture(inner);
    state.events.onGenerationFinished?.('model', 'background', 'answer', 'cancelled');
    expect(inner).toHaveBeenCalledWith('model', 'background', 'answer', 'cancelled');
    state.alerts.dispose();
  });

  it('names the chat in the alert, and falls back when the title is unknown', () => {
    const state = fixture();
    const toast = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    state.approval().requested({ conversationId: 'background' });
    state.events.onTurnFailed?.('gone', 'backend stopped');
    expect(toast.mock.calls[0]?.[0]).toBe(
      'Forge chat "Fix the lease" is waiting for tool approval.',
    );
    expect(toast.mock.calls[1]?.[0]).toBe('A Forge chat failed: backend stopped');
    state.alerts.dispose();
  });

  /** AC 1d: the owner has to be able to find a card that is stopped on them
   *  from another chat or another file, so an owner-only card is a warning
   *  with a Show button, not another "waiting for approval" toast. */
  it('warns with Show when only the owner can answer a hidden card', async () => {
    const state = fixture();
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Show');
    const toast = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const command = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    state
      .approval()
      .waitingForOwner?.({
        id: 'gate-1',
        toolName: 'shell',
        detail: 'Get-Content .env\nNothing but your answer settles this. Waiting for you.',
        dangerous: true,
        conversationId: 'background',
      });
    expect(warn).toHaveBeenCalledWith(
      'Forge chat "Fix the lease" needs your approval: shell Get-Content .env',
      'Show',
    );
    expect(toast).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(command).toHaveBeenCalledWith('workbench.view.extension.forge-sidebar');
    expect(state.switchChat).toHaveBeenCalledWith('background');
    state.alerts.dispose();
  });

  it('does not warn for a card the owner is already looking at', () => {
    const state = fixture();
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    state.setActive('background');
    state
      .approval()
      .waitingForOwner?.({
        id: 'gate-1',
        toolName: 'shell',
        detail: 'Get-Content .env',
        dangerous: true,
        conversationId: 'background',
      });
    expect(warn).not.toHaveBeenCalled();
    state.alerts.dispose();
  });

  it('alerts on an unattributed question without offering Open chat', () => {
    const state = fixture();
    const toast = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    state.question().asked({});
    expect(toast).toHaveBeenCalledWith('Forge is waiting for your answer.');
    state.alerts.dispose();
  });

  it('alerts for an unattributed approval without offering Open chat', () => {
    const state = fixture();
    const toast = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    state.approval().requested({});
    expect(toast).toHaveBeenCalledOnce();
    expect(toast.mock.calls[0]?.[0]).toMatch(/waiting/i);
    expect(toast.mock.calls[0]?.[1]).toBeUndefined();
    state.alerts.dispose();
  });

  it('suppresses short and unattributed finished turns and never alerts when a chat starts running', () => {
    const state = fixture();
    state.setVisible(false);
    const toast = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    state.events.onGenerationStarted?.('model', 'short');
    now.mockReturnValue(69_999);
    state.events.onGenerationFinished?.('model', 'short', undefined, 'completed');
    state.events.onGenerationFinished?.('model', undefined, undefined, 'completed');
    state.events.onGenerationStarted?.('model', 'running');
    expect(toast).not.toHaveBeenCalled();
    state.alerts.dispose();
  });
});
