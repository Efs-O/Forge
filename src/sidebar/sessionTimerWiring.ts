/**
 * Wiring the session timer to generation events.
 *
 * Split out of `AgentLoop`'s constructor. Turn timing is bookkeeping, not part
 * of running a turn: every generation start/finish that carries a conversation
 * starts or stops that conversation's clock, and the timer's own periodic
 * checkpoint marks the transcript dirty so elapsed time survives a reload.
 */

import type { SessionTimer } from './SessionTimer';
import type { SidebarProviderEvents } from './providerEvents';
import type { ConversationRuntime } from './sessionTypes';

export interface SessionTimerWiring {
  timer: SessionTimer;
  /** Conversations are looked up late: the lookup is registered after the
   *  AgentLoop is constructed, so a snapshot taken here would be undefined. */
  lookup: (id: string) => ConversationRuntime | undefined;
  onTranscriptChanged: (convId: string) => void;
}

/**
 * Wrap `events` in place so every conversation-bearing turn is timed.
 *
 * PromptRun events carry no conversationId and are deliberately excluded from
 * session time — a /compact summary is not the user's turn.
 */
export function wireSessionTimer(events: SidebarProviderEvents, deps: SessionTimerWiring): void {
  const { timer, lookup, onTranscriptChanged } = deps;
  const origStarted = events.onGenerationStarted;
  const origFinished = events.onGenerationFinished;

  const mark = (conversationId: string | undefined, apply: (c: ConversationRuntime) => void) => {
    if (!conversationId) return;
    const conv = lookup(conversationId);
    if (!conv) return;
    apply(conv);
    onTranscriptChanged(conversationId);
  };

  events.onGenerationStarted = (modelName, conversationId) => {
    mark(conversationId, (conv) => timer.start(conv));
    origStarted?.(modelName, conversationId);
  };
  events.onGenerationFinished = (modelName, conversationId) => {
    mark(conversationId, (conv) => timer.finish(conv));
    origFinished?.(modelName, conversationId);
  };

  timer.setCheckpointCallback((conversationId) => {
    mark(conversationId, (conv) => {
      conv.updatedAt = Date.now();
    });
  });
}
