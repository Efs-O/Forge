import type { AgentProgressEvent } from '../sidebar/AgentProgress';
import type { RemoteAgentProgress } from './RemoteAgentProgress';
import type { RemoteChannel } from './types';

/**
 * Events held while the opening message is in flight.
 *
 * Generous: a fast local model streams several hundred token events in the
 * ~200ms a Telegram sendMessage takes, and the alternative to buffering them
 * is a mirrored turn that starts mid-sentence. The cap only exists so a
 * transport that never answers cannot grow this without bound.
 */
const MAX_BUFFERED_EVENTS = 500;

export interface HostProgressOpenerDeps {
  channel: RemoteChannel;
  signal: AbortSignal;
  progress: RemoteAgentProgress;
  /**
   * The chat that should watch this conversation's sidebar-started turn, or
   * undefined for one nobody is paired to. Mirroring policy lives with the
   * caller: this module decides nothing about who hears what.
   */
  target: (conversationId: string) => string | undefined;
  onError?: (message: string) => void;
}

/**
 * Gives a turn started in the sidebar the same live remote message a turn
 * started from a chat gets.
 *
 * RemoteQueueDrain opens that message when it admits a prompt, so it only ever
 * existed for chat-originated work -- and `RemoteAgentProgress.handle` drops
 * every event for a conversation with no open message. The whole mid-turn
 * channel (streamed commentary, tool milestones, phase headlines, and the
 * notice/warning rows SidebarProvider folds in) was therefore invisible to a
 * phone watching a turn the user had started at the keyboard, which is exactly
 * the case remote control exists for. Only the finished answer reached them.
 *
 * Lives outside RemoteController because the buffering below is a real piece of
 * behaviour, not a delegation: the first events of a turn arrive before the
 * message exists, and dropping them is what the split avoids.
 */
export class HostProgressOpener {
  /** Conversations whose opening message has been requested but not returned. */
  private readonly opening = new Map<string, AgentProgressEvent[]>();
  /**
   * Conversations whose opening send the transport refused this turn. Cleared
   * by the turn's `end`. An UNPAIRED conversation is not latched here: pairing
   * is re-checked on every event (an in-memory lookup), so a chat paired
   * mid-turn starts watching at once. The latch used to cover "unpaired" too,
   * and a bus-started run is one long turn — a phone paired a minute after it
   * began saw nothing for the rest of it.
   */
  private readonly declined = new Set<string>();

  constructor(private readonly deps: HostProgressOpenerDeps) {}

  handle(event: AgentProgressEvent): void {
    const { conversationId } = event;
    if (this.deps.progress.has(conversationId)) {
      this.deps.progress.handle(event);
      return;
    }
    if (event.kind === 'end') {
      this.declined.delete(conversationId);
      return;
    }
    if (this.declined.has(conversationId)) return;
    const buffered = this.opening.get(conversationId);
    if (buffered) {
      if (buffered.length < MAX_BUFFERED_EVENTS) buffered.push(event);
      return;
    }
    if (!this.deps.channel.sendProgress || !this.deps.channel.editMessage) return;
    const chatId = this.deps.target(conversationId);
    if (!chatId) return;
    this.opening.set(conversationId, [event]);
    void this.open(conversationId, chatId);
  }

  /** Drops held events for turns that will never get a message. */
  dispose(): void {
    this.opening.clear();
    this.declined.clear();
  }

  private async open(conversationId: string, chatId: string): Promise<void> {
    try {
      const messageId = await this.deps.channel.sendProgress?.(chatId, 'Forge: working…', {
        signal: this.deps.signal,
      });
      // Re-checked after the await: the turn can end, or a chat-originated
      // prompt can claim the conversation, while the send is in flight.
      if (!messageId) {
        this.declined.add(conversationId);
        return;
      }
      if (this.deps.signal.aborted || this.deps.progress.has(conversationId)) return;
      this.deps.progress.begin(conversationId, chatId, messageId, 'host');
      for (const held of this.opening.get(conversationId) ?? []) {
        this.deps.progress.handle(held);
      }
    } catch (err) {
      this.declined.add(conversationId);
      this.deps.onError?.(
        `Forge remote progress could not be opened: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.opening.delete(conversationId);
    }
  }
}
