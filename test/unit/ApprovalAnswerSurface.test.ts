/**
 * Who is allowed to answer an approval card, and what the ledger says about it.
 *
 * The incident this pins (chat 14cd7203-e3f6-4af6-a9b8-4140e8487b0f, build
 * 0.17.215, read from its session log on 2026-11-24): a `dangerous` shell card
 * opened in a chat the owner was not looking at and was answered `declined`
 * 1316 ms later. The `gate` row called that the owner's answer, because every
 * build up to then wrote `owner` for any resolution that was not a timeout or a
 * cancel. Nothing in the log could separate a click the owner aimed at the card
 * from a keystroke that happened to land on it.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  commands: { executeCommand: vi.fn() },
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      clear: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    }),
  },
}));

import type { HostToWebview } from '../../src/sidebar/messageBridge';
import { ToolApprovalService } from '../../src/sidebar/ToolApprovalService';
import { GateEventLog, type GateEventRow } from '../../src/sidebar/gateEventLog';
import { createProviderWebviewActions } from '../../src/sidebar/providerWebviewActions';
import { routeWebviewMessage, type WebviewActions } from '../../src/sidebar/webviewMessageRouter';
import type { AgentLoop } from '../../src/sidebar/AgentLoop';
import type { ProviderWebviewCapabilities } from '../../src/sidebar/providerWebviewActions';

/** The real queue, the real ledger, and the real webview hand-off over them. */
function rig(timeoutMinutes?: number) {
  const posted: HostToWebview[] = [];
  const rows: GateEventRow[] = [];
  const service = new ToolApprovalService(
    (message) => posted.push(message),
    () => ({}) as never,
    undefined,
    () => timeoutMinutes,
  );
  service.addSink(new GateEventLog({ write: (row) => rows.push(row), now: () => Date.now() }));

  let activeConversationId = 'chat-A';
  const agentLoop = {
    resolveConfirmation: (id: string, decision: never, source: never) =>
      service.resolve(id, decision, source),
    pendingApproval: () => service.pending(),
  } as unknown as AgentLoop;

  const actions: WebviewActions = createProviderWebviewActions({
    post: (message) => posted.push(message),
    activeConversationId: () => activeConversationId,
    agentLoop,
    getView: () => ({}) as never,
    promptRouter: { route: async () => undefined } as never,
  } as unknown as ProviderWebviewCapabilities);

  const card = () => {
    const message = posted.find((item) => item.type === 'confirmRequest');
    if (message?.type !== 'confirmRequest') throw new Error('no approval card was raised');
    return message;
  };

  return {
    service,
    rows,
    posted,
    card,
    setActive: (id: string) => {
      activeConversationId = id;
    },
    /** Exactly what the sidebar sends: the router's `confirmResponse` case. */
    answerFromSidebar: (id: string, decision: 'approve' | 'decline' = 'decline') =>
      routeWebviewMessage(actions, { type: 'confirmResponse', id, decision }),
  };
}

describe('who may answer an approval card', () => {
  it('refuses a sidebar answer for a card whose chat is not the one on screen', async () => {
    const h = rig();
    const outcome = h.service.request('shell', 'rm -rf the build folder', true, 'chat-B');
    const card = h.card();

    // The owner is in chat-A: the card they can see belongs to another chat, so
    // an answer arriving from the sidebar cannot be an answer they aimed at it.
    h.answerFromSidebar(card.id);
    expect(h.rows).toEqual([]);
    expect(h.service.pendingForConversation('chat-B')?.id).toBe(card.id);

    // Show that chat, and the same answer is the owner's again.
    h.setActive('chat-B');
    h.answerFromSidebar(card.id);
    await expect(outcome).resolves.toBe('declined');
    expect(h.rows[0]).toMatchObject({ kind: 'card', answered_by: 'webview' });
  });

  it('records a sidebar answer as the sidebar, never as an unnamed owner', () => {
    const h = rig();
    h.service.request('shell', 'rm the log', true, 'chat-A');
    const card = h.card();
    h.setActive('chat-A');
    h.answerFromSidebar(card.id, 'approve');
    expect(h.rows[0]?.answered_by).toBe('webview');
    expect(h.rows.some((row) => row.answered_by === 'owner')).toBe(false);
  });

  it('records a Telegram button as telegram and a spoken answer as voice', () => {
    const h = rig();
    h.service.request('shell', 'rm the log', true, 'chat-A');
    const first = h.card();
    h.service.resolve(first.id, 'approve', 'telegram');
    h.service.request('shell', 'rm the cache', true, 'chat-A');
    const second = h.posted.filter((item) => item.type === 'confirmRequest').at(-1)!;
    if (second.type !== 'confirmRequest') throw new Error('no second card');
    h.service.resolve(second.id, 'decline', 'voice');
    expect(h.rows.map((row) => row.answered_by)).toEqual(['telegram', 'voice']);
  });

  it('records a card nobody answered as a timeout, and one a Stop closed as a cancel', async () => {
    vi.useFakeTimers();
    const h = rig(1);
    const timedOut = h.service.request('shell', 'rm the log', true, 'chat-A');
    vi.advanceTimersByTime(60_000);
    await expect(timedOut).resolves.toMatchObject({ kind: 'timeout' });
    expect(h.rows[0]?.answered_by).toBe('timeout');

    const stopped = h.service.request('delete_file', 'recycle the cache', true, 'chat-A');
    h.service.cancelConversation('chat-A');
    await expect(stopped).resolves.toBe('declined');
    expect(h.rows[1]?.answered_by).toBe('cancel');
    vi.useRealTimers();
  });

  it('still lets a card with no chat be answered from the sidebar', () => {
    const h = rig();
    h.setActive('chat-A');
    h.service.request('shell', 'rm the log', true);
    const card = h.card();
    h.answerFromSidebar(card.id, 'approve');
    expect(h.rows[0]?.answered_by).toBe('webview');
  });
});
