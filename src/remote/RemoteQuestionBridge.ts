import type {
  UserQuestionAnsweredEvent,
  UserQuestionRequestEvent,
} from '../sidebar/UserQuestionService';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel } from './types';
import { renderQuestionAsText } from '../util/questionAnswers';

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
    // An unaddressed question cannot be attributed to a chat: the sidebar and
    // the desktop prompt stay its only surfaces.
    if (!event.conversationId) return;
    const chatId = this.chatFor(event.conversationId);
    if (!chatId) return;
    this.questions.set(event.id, { chatId, event });
    void this.publish(event.id);
  }

  /**
   * Which chat is asked the question.
   *
   * The queued request first, then the conversation's binding. The fallback is
   * the case this used to refuse: a turn started in the sidebar blocks on
   * ask_user with nothing said remotely, so a phone watching it sees the work
   * stop and never learns it is waiting on an answer only the keyboard can
   * give. The cost is that `answerText` can now claim a plain message sent
   * while such a question is open -- bounded to the seconds a gate is up, and
   * `/`-prefixed commands are never claimed.
   */
  private chatFor(conversationId: string): string | undefined {
    const chain = this.host
      .status()
      .requestChains.find((item) => item.conversationId === conversationId);
    const request = chain?.remoteRequestId
      ? this.store.getRequest(chain.remoteRequestId)
      : undefined;
    if (request) return request.channel === this.channel.name ? request.chatId : undefined;
    return this.store.bindingsForConversation(conversationId, this.channel.name)[0]?.chatId;
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
    // Rendered by the shared owner so a "1 2" typed here means exactly what
    // it means clicked in the sidebar -- the numbering is the contract.
    const body = renderQuestionAsText(
      pending.event.prompt,
      pending.event.options,
      pending.event.questions,
    );
    try {
      await this.channel.send(
        pending.chatId,
        `Forge asks: ${body}`.slice(0, this.maxMessageChars),
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
