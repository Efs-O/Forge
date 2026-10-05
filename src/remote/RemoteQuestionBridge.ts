import type {
  UserQuestionAnsweredEvent,
  UserQuestionRequestEvent,
} from '../sidebar/UserQuestionService';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { CommandCleanupScheduler } from './CommandCleanupScheduler';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';
import {
  formatGroupAnswer,
  renderQuestionAsText,
  resolveAnswerText,
  type QuestionGroup,
} from '../util/questionAnswers';
import { telegramQuestionButtons } from './TelegramQuestionButtons';

interface RemoteQuestionEntry {
  chatId: string;
  event: UserQuestionRequestEvent;
  messageId?: string;
  freeTextMode: boolean;
  /** The "send your answer as text" prompt, deleted once the question closes. */
  textPromptIds?: string[];
  /** False until the chat has been shown it; a locked chat is shown it on unlock. */
  delivered: boolean;
  /**
   * Sub-questions asked one keyboard at a time (Telegram only). A keyboard
   * answers one list, so several lists become several messages in turn.
   */
  steps?: readonly QuestionGroup[];
  /** Answers given so far, one per step; its length is the current step. */
  picks?: string[];
  /** The step whose keyboard is on screen, so a step is never shown twice. */
  shownStep?: number;
  /** Serialises step keyboards: two quick replies must not race two sends. */
  sending?: Promise<void>;
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
    /** Deletes a routine receipt after the command-reply delay; absent in rigs = kept. */
    private readonly cleanup?: CommandCleanupScheduler,
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

  /**
   * Shows a newly authenticated chat the questions it could not be handed while
   * locked. `publish` drops a question for a locked chat, so without this an
   * ask_user raised before the owner unlocked (e.g. just after a window reload)
   * never reaches the phone while the turn waits on it.
   */
  republish(chatId: string): void {
    for (const [id, entry] of this.questions) {
      if (entry.chatId === chatId && !entry.delivered) void this.publish(id);
    }
  }

  /** Answers the chat's outstanding question. False when there is none. */
  answerText(chatId: string, text: string): boolean {
    for (const [id, entry] of this.questions) {
      if (entry.chatId !== chatId) continue;
      if (entry.steps) {
        // Typed text answers the sub-question on screen; a bare number picks its option.
        const group = entry.steps[entry.picks?.length ?? 0];
        return this.takeAnswer(entry, resolveAnswerText(text, group?.options));
      }
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
    // A stepped question clears each keyboard before the next one is sent, so
    // an absent message id there means "between steps", not "not yet known".
    if ((pending.messageId || pending.steps) && pending.messageId !== event.messageId) {
      return { kind: 'rejected', reason: 'question button is stale' };
    }
    const options = this.currentOptions(pending);
    if (!options) {
      return { kind: 'rejected', reason: 'question does not have a Telegram choice list' };
    }
    if (event.action === 'other') {
      if (pending.freeTextMode) return { kind: 'handled' };
      pending.freeTextMode = true;
      await this.clearKeyboard(pending);
      const step = pending.steps ? ` to question ${(pending.picks?.length ?? 0) + 1}` : '';
      const ids = await this.sendNotice(pending.chatId, `Forge: send your answer${step} as text.`);
      if (ids?.length) pending.textPromptIds = ids;
      return { kind: 'handled' };
    }
    if (event.choice === undefined) {
      return { kind: 'rejected', reason: 'question choice is missing' };
    }
    const answer = options[event.choice];
    if (answer === undefined) return { kind: 'rejected', reason: 'question choice is invalid' };
    if (pending.steps) {
      // Cleared before the next step is sent, so a double tap finds no keyboard.
      await this.clearKeyboard(pending);
      if (!this.takeAnswer(pending, answer)) {
        return { kind: 'rejected', reason: 'question is already settled' };
      }
      await pending.sending;
      return { kind: 'handled' };
    }
    const accepted = this.host.answerQuestion(event.questionId, answer);
    if (!accepted) return { kind: 'rejected', reason: 'question is already settled' };
    this.questions.delete(event.questionId);
    await this.clearKeyboard(pending);
    return { kind: 'handled' };
  }

  /** The choice list on screen: the flat options, or the current step's. */
  private currentOptions(pending: RemoteQuestionEntry): readonly string[] | undefined {
    if (pending.steps) return pending.steps[pending.picks?.length ?? 0]?.options;
    if (pending.event.questions?.length) return undefined;
    return pending.event.options?.length ? pending.event.options : undefined;
  }

  /**
   * Records one step's answer, then shows the next step or settles the whole
   * question with the same labelled lines the sidebar dialog sends.
   */
  private takeAnswer(pending: RemoteQuestionEntry, answer: string): boolean {
    const steps = pending.steps!;
    const picks = [...(pending.picks ?? []), answer];
    if (picks.length >= steps.length) {
      return this.host.answerQuestion(pending.event.id, formatGroupAnswer(steps, picks));
    }
    pending.picks = picks;
    pending.freeTextMode = false;
    void this.deleteTextPrompt(pending);
    void this.showStep(pending);
    return true;
  }

  private showStep(pending: RemoteQuestionEntry): Promise<void> {
    pending.sending = (pending.sending ?? Promise.resolve()).then(async () => {
      const step = pending.picks?.length ?? 0;
      if (this.questions.get(pending.event.id) !== pending || pending.shownStep === step) return;
      await this.clearKeyboard(pending);
      await this.sendKeyboard(pending);
    });
    return pending.sending;
  }

  private onAsked(event: UserQuestionRequestEvent): void {
    // An unaddressed question cannot be attributed to a chat: the sidebar and
    // the desktop prompt stay its only surfaces.
    if (!event.conversationId) return;
    const chatId = this.chatFor(event.conversationId);
    if (!chatId) return;
    const steps = this.channel.name === 'telegram' ? event.questions : undefined;
    this.questions.set(event.id, {
      chatId,
      event,
      freeTextMode: false,
      delivered: false,
      ...(steps?.length ? { steps } : {}),
    });
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
    void this.deleteTextPrompt(pending);
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
    if (this.channel.name === 'telegram' && this.currentOptions(pending)) {
      await this.showStep(pending);
      return;
    }
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
      pending.delivered = true;
    } catch (err) {
      this.onError?.(
        `Forge remote question delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Sends the keyboard for the flat choice list, or for the current step. */
  private async sendKeyboard(pending: RemoteQuestionEntry): Promise<void> {
    const sendInlineKeyboard = this.channel.sendInlineKeyboard;
    if (!sendInlineKeyboard) {
      await this.failDelivery(pending, 'Telegram inline choices are unavailable.');
      return;
    }
    const step = pending.picks?.length ?? 0;
    const group = pending.steps?.[step];
    const text = group
      ? `Forge asks: ${pending.event.prompt}\n\nQuestion ${step + 1} of ${pending.steps!.length}: ${group.prompt}`
      : `Forge asks: ${renderQuestionAsText(pending.event.prompt, pending.event.options)}`;
    try {
      const messageId = await sendInlineKeyboard.call(
        this.channel,
        pending.chatId,
        text.slice(0, this.maxMessageChars),
        telegramQuestionButtons(pending.event.id, group?.options ?? pending.event.options!),
        { signal: this.signal },
      );
      pending.delivered = true;
      pending.shownStep = step;
      if (this.questions.get(pending.event.id) === pending) {
        if (messageId) pending.messageId = messageId;
      } else if (messageId) {
        await this.clearKeyboard({ ...pending, messageId });
      }
    } catch (err) {
      await this.failDelivery(pending, err instanceof Error ? err.message : String(err));
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

  private async sendNotice(chatId: string, text: string): Promise<string[] | undefined> {
    try {
      const sent = await this.channel.send(chatId, text.slice(0, this.maxMessageChars), {
        signal: this.signal,
      });
      return sent ?? undefined;
    } catch (err) {
      this.onError?.(
        `Forge remote question notice failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /** Best-effort: the prompt is presentation only, so a failed delete is reported, not retried. */
  private async deleteTextPrompt(entry: RemoteQuestionEntry): Promise<void> {
    const ids = entry.textPromptIds ?? [];
    delete entry.textPromptIds;
    for (const id of ids) {
      try {
        await this.channel.deleteMessage?.(entry.chatId, id, { signal: this.signal });
      } catch (err) {
        this.onError?.(
          `Forge remote question prompt cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
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
      const sent = await this.channel.send(pending.chatId, text, { signal: this.signal });
      // An answer is a receipt; a dismissal means the turn got nothing, so it stays.
      if (event.reason === 'answered') this.cleanup?.armEphemeral(pending.chatId, sent ?? []);
    } catch (err) {
      this.onError?.(
        `Forge remote question update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
