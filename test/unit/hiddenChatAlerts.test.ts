import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HiddenChatAlerts } from '../../src/sidebar/hiddenChatAlerts';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  let approval:
    | {
        requested: (event: { conversationId?: string }) => void;
        resolved: (event: { conversationId?: string }) => void;
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
    onGenerationFinished?: (model: string | null, id?: string) => void;
    onTurnFailed?: (id: string | undefined, message: string) => void;
  } = {};
  let active = 'visible';
  let visible = true;
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
    activeConversationId: () => active,
    view: () => ({ visible }) as vscode.WebviewView,
    switchConversation: switchChat,
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
    state.events.onGenerationFinished?.('model', 'background');
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
    state.events.onGenerationFinished?.('model', 'long');
    state.events.onTurnFailed?.(undefined, 'backend stopped');
    expect(toast).toHaveBeenCalledTimes(2);
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
    state.events.onGenerationFinished?.('model', 'short');
    state.events.onGenerationFinished?.('model');
    state.events.onGenerationStarted?.('model', 'running');
    expect(toast).not.toHaveBeenCalled();
    state.alerts.dispose();
  });
});
