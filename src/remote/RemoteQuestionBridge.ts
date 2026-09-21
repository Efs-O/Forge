import type {
  UserQuestionAnsweredEvent,
  UserQuestionRequestEvent,
} from '../sidebar/UserQuestionService';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';
import { renderQuestionAsText } from '../util/questionAnswers';
import { telegramQuestionButtons } from './TelegramQuestionButtons';

interface RemoteQuestionEntry {
  chatId: string;
  event: UserQuestionRequestEvent;
  messageId?: string;
  freeTextMode: boolean;
}

type QuestionActionEvent = Extract<RemoteInboundEvent, { kind: 'question_action' }>;

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
      const accepted = this.host.answerQuestion(id, text);
      if (accepted) {
        this.questions.delete(id);
        void this.clearKeyboard(entry);
      }
      return accepted;
    }
    return false;
  }

  /** Settles a Telegram button action only against its exact pending question. */
  async handleAction(event: QuestionActionEvent): Promise<RemoteInboundDisposition> {
    if (event.channel !== this.channel.name) {
      return { kind: 'rejected', reason: 'question belongs to another transport' };
    }
    const pending = this.questions.get(event.questionId);
    if (!pending || pending.chatId !== event.chatId) {
      return { kind: 'rejected', reason: 'question is stale or not owned by this chat' };
    }
    if (pending.messageId && pending.messageId !== event.messageId) {
      return { kind: 'rejected', reason: 'question button is stale' };
    }
    if (!pending.event.options?.length || pending.event.questions?.length) {
      return { kind: 'rejected', reason: 'question does not have a Telegram choice list' };
    }
    if (event.action === 'other') {
      if (pending.freeTextMode) return { kind: 'handled' };
      pending.freeTextMode = true;
      await this.clearKeyboard(pending);
      await this.sendNotice(pending.chatId, 'Forge: send your answer as text.');
      return { kind: 'handled' };
    }
    if (event.choice === undefined) {
      return { kind: 'rejected', reason: 'question choice is missing' };
    }
    const answer = pending.event.options[event.choice];
    if (answer === undefined) return { kind: 'rejected', reason: 'question choice is invalid' };
    const accepted = this.host.answerQuestion(event.questionId, answer);
    if (!accepted) return { kind: 'rejected', reason: 'question is already settled' };
    this.questions.delete(event.questionId);
    await this.clearKeyboard(pending);
    return { kind: 'handled' };
  }

  private onAsked(event: UserQuestionRequestEvent): void {
    // An unaddressed question cannot be attributed to a chat: the sidebar and
    // the desktop prompt stay its only surfaces.
    if (!event.conversationId) return;
    const chatId = this.chatFor(event.conversationId);
    if (!chatId) return;
    this.questions.set(event.id, { chatId, event, freeTextMode: false });
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
    void this.clearKeyboard(pending);
    // Only worth reporting when the answer came from somewhere else; a remote
    // answer already echoes as the message the user just sent.
    void this.publishResolution(pending, event);
  }

  private async publish(id: string): Promise<void> {
    const pending = this.questions.get(id);
    if (!pending) return;
    // An expired session must not be handed the question text.
    if (!(await this.auth.canDeliver(this.channel.name, pending.chatId))) return;
    // A sidebar answer may have won while the session check was awaiting.
    if (this.questions.get(id) !== pending) return;
    // Rendered by the shared owner so a "1 2" typed here means exactly what
    // it means clicked in the sidebar -- the numbering is the contract.
    const body = renderQuestionAsText(
      pending.event.prompt,
      pending.event.options,
      pending.event.questions,
    );
    const flatChoices = pending.event.options?.length && !pending.event.questions?.length;
    if (this.channel.name === 'telegram' && flatChoices) {
      const sendInlineKeyboard = this.channel.sendInlineKeyboard;
      if (!sendInlineKeyboard) {
        await this.failDelivery(pending, 'Telegram inline choices are unavailable.');
        return;
      }
      try {
        const messageId = await sendInlineKeyboard.call(
          this.channel,
          pending.chatId,
          `Forge asks: ${body}`.slice(0, this.maxMessageChars),
          telegramQuestionButtons(pending.event.id, pending.event.options!),
          { signal: this.signal },
        );
        if (this.questions.get(id) === pending) {
          if (messageId) pending.messageId = messageId;
        } else if (messageId) {
          await this.clearKeyboard({ ...pending, messageId });
        }
      } catch (err) {
        await this.failDelivery(pending, err instanceof Error ? err.message : String(err));
      }
      return;
    }
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

  private async failDelivery(pending: RemoteQuestionEntry, detail: string): Promise<void> {
    this.onError?.(`Forge remote question delivery failed: ${detail}`);
    if (this.questions.get(pending.event.id) !== pending) return;
    const accepted = this.host.dismissQuestion(pending.event.id);
    if (!accepted) return;
    this.questions.delete(pending.event.id);
    await this.sendNotice(
      pending.chatId,
      'Forge: I could not present that choice question with Telegram buttons, so the question was cancelled.',
    );
  }

  private async sendNotice(chatId: string, text: string): Promise<void> {
    try {
      await this.channel.send(chatId, text.slice(0, this.maxMessageChars), {
        signal: this.signal,
      });
    } catch (err) {
      this.onError?.(
        `Forge remote question notice failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async clearKeyboard(entry: RemoteQuestionEntry): Promise<void> {
    const messageId = entry.messageId;
    if (!messageId) return;
    delete entry.messageId;
    try {
      await this.channel.clearInlineKeyboard?.(entry.chatId, messageId, { signal: this.signal });
    } catch (err) {
      this.onError?.(
        `Forge remote question keyboard cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
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
