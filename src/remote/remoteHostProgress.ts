import type { AgentProgressEvent } from '../sidebar/AgentProgress';
import type { RemoteAgentProgress } from './RemoteAgentProgress';
import type { RemoteChannel } from './types';
import { openProgressBubble, removeProgressStopControl } from './remoteProgressOpen';

/**
 * Events held while the opening message is in flight.
 *
 * Generous: a fast local model streams several hundred token events in the
 * ~200ms a Telegram sendMessage takes, and the alternative to buffering them
 * is a mirrored turn that starts mid-sentence. The cap only exists so a
 * transport that never answers cannot grow this without bound.
 */
const MAX_BUFFERED_EVENTS = 500;
const LOCK_RECHECK_MS = 10_000;

const STOPPED_TEXT =
  'Forge: stopped following this turn — the chat now follows another conversation.';

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
  canDeliver: (chatId: string) => Promise<boolean>;
  enqueuePrompt?: (chatId: string, text: string) => Promise<void>;
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
  private readonly lockedCheckedAt = new Map<string, number>();
  private readonly prompts = new Map<string, Array<{ chatId: string; text: string }>>();

  constructor(private readonly deps: HostProgressOpenerDeps) {}

  handle(event: AgentProgressEvent): void {
    const { conversationId } = event;
    const prompts = this.prompts.get(conversationId);
    if (prompts?.length && prompts[0]!.chatId !== this.deps.target(conversationId)) {
      this.prompts.delete(conversationId);
    }
    const claimed = this.deps.progress.hostChat(conversationId);
    if (claimed !== undefined && claimed !== this.deps.target(conversationId)) {
      // The chat was switched to another conversation (or unpaired) mid-turn.
      // The message used to keep streaming until the turn ended, so a phone
      // following one chat heard two. Close it; if another chat now watches
      // this conversation, the code below opens a message there.
      void this.deps.progress.finish(conversationId, STOPPED_TEXT);
    }
    if (this.deps.progress.has(conversationId)) {
      this.deps.progress.handle(event);
      if (event.kind === 'end') this.lockedCheckedAt.delete(conversationId);
      return;
    }
    if (event.kind === 'end') {
      const buffered = this.opening.get(conversationId);
      if (buffered) {
        if (buffered.length < MAX_BUFFERED_EVENTS) buffered.push(event);
        return;
      }
      this.declined.delete(conversationId);
      this.lockedCheckedAt.delete(conversationId);
      void this.flushPrompt(conversationId);
      return;
    }
    if (this.declined.has(conversationId)) return;
    const checkedAt = this.lockedCheckedAt.get(conversationId);
    if (checkedAt !== undefined && Date.now() - checkedAt < LOCK_RECHECK_MS) return;
    const buffered = this.opening.get(conversationId);
    if (buffered) {
      if (buffered.length < MAX_BUFFERED_EVENTS) buffered.push(event);
      return;
    }
    if (!this.deps.channel.sendProgress) return;
    const chatId = this.deps.target(conversationId);
    if (!chatId) return;
    this.opening.set(conversationId, [event]);
    void this.open(conversationId, chatId);
  }

  /** Holds a formatted sidebar prompt until progress opens or the turn ends. */
  stashPrompt(conversationId: string, chatId: string, text: string): void {
    const prompts = this.prompts.get(conversationId) ?? [];
    prompts.push({ chatId, text });
    this.prompts.set(conversationId, prompts);
  }

  /** Drops held events for turns that will never get a message. */
  dispose(): void {
    this.opening.clear();
    this.declined.clear();
    this.lockedCheckedAt.clear();
    this.prompts.clear();
  }

  private async open(conversationId: string, chatId: string): Promise<void> {
    try {
      const firstPrompt = this.prompts.get(conversationId)?.[0];
      const bubble = await openProgressBubble(
        this.deps.channel,
        chatId,
        'Forge: working…',
        this.deps.signal,
        () => this.deps.canDeliver(chatId),
        firstPrompt?.text,
      );
      // Re-checked after the await: the turn can end, or a chat-originated
      // prompt can claim the conversation, while the send is in flight.
      if (bubble.kind === 'declined') {
        if (bubble.promptSent && firstPrompt) this.shiftPrompt(conversationId, firstPrompt);
        if (bubble.locked) this.lockedCheckedAt.set(conversationId, Date.now());
        else {
          this.declined.add(conversationId);
          void this.flushPrompt(conversationId);
        }
        if (
          bubble.locked &&
          this.opening.get(conversationId)?.some((event) => event.kind === 'end')
        ) {
          void this.flushPrompt(conversationId);
        }
        if (bubble.error) {
          this.deps.onError?.(`Forge remote progress could not be opened: ${bubble.error}`);
        }
        return;
      }
      if (bubble.promptSent && firstPrompt) this.shiftPrompt(conversationId, firstPrompt);
      if (this.deps.signal.aborted || this.deps.progress.has(conversationId)) {
        // A bubble opened for a turn that is no longer ours to report. It is
        // not deleted here because the existing policy never deleted a progress
        // message it did not finish, and inventing a delete path here would be
        // a new behaviour this phase does not need.
        if (bubble.kind === 'plain' && bubble.stopMessageId && bubble.stopMessageIsControl) {
          try {
            await removeProgressStopControl(this.deps.channel, chatId, bubble.stopMessageId);
          } catch (err) {
            this.deps.onError?.(
              `Forge remote Stop control cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (bubble.stopMessageId && !bubble.stopMessageIsControl) {
          try {
            await this.deps.channel.removeProgressStopKeyboard?.(chatId);
          } catch (err) {
            this.deps.onError?.(
              `Forge remote Stop keyboard cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        return;
      }
      this.deps.progress.begin(
        conversationId,
        chatId,
        bubble.messageId,
        'host',
        bubble.stopMessageId,
        bubble.stopMessageIsControl,
      );
      this.flushPromptsToLive(conversationId);
      if (bubble.error)
        this.deps.onError?.(`Forge remote progress could not fully open: ${bubble.error}`);
      for (const held of this.opening.get(conversationId) ?? []) {
        this.deps.progress.handle(held);
      }
    } catch (err) {
      this.declined.add(conversationId);
      void this.flushPrompt(conversationId);
      this.deps.onError?.(
        `Forge remote progress could not be opened: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.opening.delete(conversationId);
    }
  }

  private async flushPrompt(conversationId: string): Promise<void> {
    const pending = this.prompts.get(conversationId);
    if (!pending?.length) return;
    this.prompts.delete(conversationId);
    for (let index = 0; index < pending.length; index += 1) {
      const prompt = pending[index]!;
      try {
        await this.deps.enqueuePrompt?.(prompt.chatId, prompt.text);
      } catch (err) {
        this.prompts.set(conversationId, pending.slice(index));
        this.deps.onError?.(
          `Forge mirrored prompt could not be held for delivery: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }
  }

  private shiftPrompt(conversationId: string, expected: { chatId: string; text: string }): void {
    const pending = this.prompts.get(conversationId);
    if (pending?.[0]?.chatId === expected.chatId && pending[0].text === expected.text) {
      pending.shift();
      if (pending.length === 0) this.prompts.delete(conversationId);
    }
  }

  private flushPromptsToLive(conversationId: string): void {
    const pending = this.prompts.get(conversationId);
    if (!pending?.length) return;
    const unsent: typeof pending = [];
    for (const prompt of pending) {
      if (
        !this.deps.progress.mirrorPrompt(
          conversationId,
          prompt.text,
          (chatId, text) => this.deps.enqueuePrompt?.(chatId, text) ?? Promise.resolve(),
        )
      ) {
        unsent.push(prompt);
      }
    }
    if (unsent.length > 0) this.prompts.set(conversationId, unsent);
    else this.prompts.delete(conversationId);
  }
}
