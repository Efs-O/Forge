import type {
  UserQuestionAnsweredEvent,
  UserQuestionRequestEvent,
} from '../sidebar/UserQuestionService';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel } from './types';

interface RemoteQuestionEntry {
  chatId: string;
  event: UserQuestionRequestEvent;
}

/**
 * Presents an agent question in the chat that started the turn.
 *
 * The approval bridge cannot serve this: an approval is a two-button callback,
 * while a question needs free text back. So the question is sent as an ordinary
 * message and the chat's next non-command text is routed here as its answer --
 * see RemoteController.handle().
 */
export class RemoteQuestionBridge {
  private readonly questions = new Map<string, RemoteQuestionEntry>();
  private subscription: { dispose(): void } | undefined;

  constructor(
    private readonly channel: RemoteChannel,
    private readonly store: RemoteRequestStore,
    private readonly auth: RemoteAuth,
    private readonly host: ForgeHostFacade,
    private readonly signal: AbortSignal,
    private maxMessageChars: number,
    private readonly onError?: (message: string) => void,
  ) {}

  start(): void {
    this.subscription = this.host.addQuestionSink({
      asked: (event) => this.onAsked(event),
      answered: (event) => this.onAnswered(event),
    });
  }

  stop(): void {
    this.subscription?.dispose();
    this.subscription = undefined;
    this.questions.clear();
  }

  updateMaxMessageChars(maxMessageChars: number): void {
    this.maxMessageChars = maxMessageChars;
  }

  /** True while this chat owes an answer, so the controller routes text here. */
  hasPending(chatId: string): boolean {
    for (const entry of this.questions.values()) {
      if (entry.chatId === chatId) return true;
    }
    return false;
  }

  /** Answers the chat's outstanding question. False when there is none. */
  answerText(chatId: string, text: string): boolean {
    for (const [id, entry] of this.questions) {
      if (entry.chatId !== chatId) continue;
      this.questions.delete(id);
      return this.host.answerQuestion(id, text);
    }
    return false;
  }

  private onAsked(event: UserQuestionRequestEvent): void {
    // No conversation, or no remote chain behind it, means the turn is local:
    // stay silent and let the desktop prompt be the only surface.
    if (!event.conversationId) return;
    const chain = this.host
      .status()
      .requestChains.find((item) => item.conversationId === event.conversationId);
    if (!chain?.remoteRequestId) return;
    const request = this.store.getRequest(chain.remoteRequestId);
    if (!request || request.channel !== this.channel.name) return;
    this.questions.set(event.id, { chatId: request.chatId, event });
    void this.publish(event.id);
  }

  private onAnswered(event: UserQuestionAnsweredEvent): void {
    const pending = this.questions.get(event.id);
    if (!pending) return;
    this.questions.delete(event.id);
    // Only worth reporting when the answer came from somewhere else; a remote
    // answer already echoes as the message the user just sent.
    void this.publishResolution(pending, event);
  }

  private async publish(id: string): Promise<void> {
    const pending = this.questions.get(id);
    if (!pending) return;
    // An expired session must not be handed the question text.
    if (!(await this.auth.canDeliver(this.channel.name, pending.chatId))) return;
    const options = pending.event.options?.length
      ? `\n${pending.event.options.map((option, index) => `${index + 1}. ${option}`).join('\n')}` +
        '\n\nReply with the number or the text.'
      : '\n\nReply with your answer.';
    try {
      await this.channel.send(
        pending.chatId,
        `Forge asks: ${pending.event.prompt}${options}`.slice(0, this.maxMessageChars),
        { signal: this.signal },
      );
    } catch (err) {
      this.onError?.(
        `Forge remote question delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async publishResolution(
    pending: RemoteQuestionEntry,
    event: UserQuestionAnsweredEvent,
  ): Promise<void> {
    if (!(await this.auth.canDeliver(this.channel.name, pending.chatId))) return;
    const text =
      event.reason === 'answered'
        ? `Forge: answered — "${(event.answer ?? '').slice(0, 120)}"`
        : 'Forge: the question was dismissed without an answer.';
    try {
      await this.channel.send(pending.chatId, text, { signal: this.signal });
    } catch (err) {
      this.onError?.(
        `Forge remote question update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
