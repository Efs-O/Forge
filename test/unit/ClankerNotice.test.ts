import { describe, expect, it, vi } from 'vitest';
import { SlashCommandHandler, type SlashCommandDeps } from '../../src/sidebar/SlashCommandHandler';
import type { HostToWebview } from '../../src/sidebar/messageBridge';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import { reducer, initialState } from '../../webview-ui/src/reducer';
import { hostMessageToAction } from '../../webview-ui/src/hostActions';

describe('Clanker status delivery', () => {
  for (const on of [true, false]) {
    for (const streaming of [false, true]) {
      it(`${on ? 'ON' : 'OFF'} stays a notice ${streaming ? 'during streaming' : 'before the first reply'}`, async () => {
        const posted: HostToWebview[] = [];
        const handler = new SlashCommandHandler({
          getActiveConv: () => ({ id: 'target' }) as ConversationRuntime,
          toggleClanker: () => on,
          post: (msg: HostToWebview) => posted.push(msg),
        } as unknown as SlashCommandDeps);
        let state = { ...initialState, activeConversationId: 'visible' };
        if (streaming) {
          state = reducer(state, { type: 'GENERATION_STARTED', convId: 'target' });
          state = reducer(state, { type: 'TOKEN', text: 'Earlier reply. ', convId: 'target' });
        }
        await handler.handle('clanker');
        const expectedNotice = on
          ? "\n> 💥 **Clanker Mode ON** — this chat only. Deny-listed destructive shell commands, Forge guard files, and sending data out after reading a secret still stop. `/clanker` again turns it off.\n"
          : '\n> 💥 **Clanker Mode OFF** — this chat is gated again. The approvals this chat earned are not revoked.\n';
        expect(posted[0]?.message).toBe(expectedNotice);
        expect(posted).toEqual([
          expect.objectContaining({
            type: 'notice',
            conversationId: 'target',
            message: expect.stringContaining(`Clanker Mode ${on ? 'ON' : 'OFF'}`),
          }),
        ]);
        for (const msg of posted) state = reducer(state, hostMessageToAction(msg)!);
        state = reducer(state, { type: 'REASONING_TOKEN', text: 'Thinking', convId: 'target' });
        state = reducer(state, { type: 'TOKEN', text: 'Answer', convId: 'target' });
        expect(state.messagesById.visible ?? []).toEqual([]);
        const rows = state.messagesById.target!;
        expect(rows.slice(-3).map((row) => [row.role, row.content, row.reasoning])).toEqual([
          ['system', expect.stringContaining('Clanker Mode'), undefined],
          ['assistant', '', 'Thinking'],
          ['assistant', 'Answer', undefined],
        ]);
        state = reducer(state, { type: 'DONE', convId: 'target' });
        state = reducer(state, {
          type: 'SESSION_SYNC',
          activeId: 'visible',
          tabs: ['visible', 'target'].map((id) => ({
            id,
            title: id,
            createdAt: 0,
            updatedAt: 0,
            messageCount: 1,
          })),
          history: [],
          messagesById: {
            target: [
              {
                role: 'assistant',
                content: streaming ? 'Earlier reply. Answer' : 'Answer',
                reasoning: 'Thinking',
              },
            ],
          },
        });
        expect(
          state.messagesById
            .target!.filter((row) => row.role === 'assistant')
            .map((row) => row.content)
            .join(''),
        ).toContain('Answer');
      });
    }
  }
});
