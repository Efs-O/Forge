import type {
  UserQuestionAnsweredEvent,
  UserQuestionRequestEvent,
} from '../sidebar/UserQuestionService';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { renderQuestionAsText } from '../util/questionAnswers';
import type { CommandCleanupScheduler } from './CommandCleanupScheduler';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';
import {
  applyRemoteQuestionStep,
  applyRemoteQuestionText,
  buildRemoteQuestionKeyboard,
  createRemoteQuestionStepState,
  questionStepAction,
  renderRemoteQuestionNotePrompt,
  renderRemoteQuestionStep,
  renderRemoteQuestionStepReceipt,
  type RemoteQuestionStepState,
} from './RemoteQuestionSteps';

type QuestionActionEvent = Extract<RemoteInboundEvent, { kind: 'question_action' }>;

interface RemoteQuestionEntry {
  chatId: string;
  event: UserQuestionRequestEvent;
  state: RemoteQuestionStepState;
  messageId?: string | undefined;
  messageTexts: Map<string, string>;
  textPromptIds?: string[];
  delivered: boolean;
  skipReceipt: boolean;
  callbackIds: Set<string>;
  actionQueue: Promise<void>;
}

interface ActionOutcome {
  disposition: RemoteInboundDisposition;
  callbackText?: string;
}

/** Sends questions to the bound chat and arbitrates button and typed replies. */
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
  hasPending(chatId: string): boolean {
    return [...this.questions.values()].some((entry) => entry.chatId === chatId);
  }
  /** Shows a locked chat each question it missed after owner authentication. */
  republish(chatId: string): void {
    for (const [id, entry] of this.questions) {
      if (entry.chatId === chatId && !entry.delivered) {
        void this.enqueue(entry, () => this.publish(id));
      }
    }
  }
  /** Routes typed text for the first outstanding question in this chat. */
  answerText(chatId: string, text: string): boolean {
    for (const entry of this.questions.values()) {
      if (entry.chatId !== chatId) continue;
      void this.enqueue(entry, () => this.answerTextForEntry(entry, text)).catch((err: unknown) => {
        this.report('question text handling', err);
      });
      return true;
    }
    return false;
  }
  /** Applies one callback and acknowledges it so Telegram never spins. */
  async handleAction(event: QuestionActionEvent): Promise<RemoteInboundDisposition> {
    let outcome: ActionOutcome;
    try {
      const entry = this.questions.get(event.questionId);
      outcome = entry
        ? await this.enqueue(entry, () => this.applyCallback(entry, event))
        : rejected('question is stale or not owned by this chat');
    } catch (err) {
      this.report('question button update', err);
      outcome = {
        disposition: { kind: 'handled' },
        callbackText: 'Forge could not update this question.',
      };
    }
    try {
      await this.channel.answerCallbackQuery?.(event.providerMessageId, outcome.callbackText, {
        signal: this.signal,
      });
    } catch (err) {
      this.report('question callback acknowledgement', err);
    }
    return outcome.disposition;
  }

  private async applyCallback(
    entry: RemoteQuestionEntry,
    event: QuestionActionEvent,
  ): Promise<ActionOutcome> {
    if (event.channel !== this.channel.name)
      return rejected('question belongs to another transport');
    if (this.questions.get(event.questionId) !== entry || entry.chatId !== event.chatId) {
      return rejected('question is stale or not owned by this chat');
    }
    if (!entry.messageId || entry.messageId !== event.messageId) {
      return rejected('question button is stale');
    }
    if (entry.callbackIds.has(event.providerMessageId)) return { disposition: { kind: 'handled' } };
    entry.callbackIds.add(event.providerMessageId);
    if (entry.callbackIds.size > 256) {
      const oldest = entry.callbackIds.values().next();
      if (!oldest.done) entry.callbackIds.delete(oldest.value);
    }

    const action = questionStepAction(event.action, event.choice);
    if (!action) return rejected('question action is invalid');
    const previous = entry.state;
    const result = applyRemoteQuestionStep(previous, action);
    if (result.effect.kind === 'toast') {
      return { disposition: { kind: 'handled' }, callbackText: result.effect.text };
    }
    entry.state = result.state;
    const callbackText = await this.applyEffect(entry, previous, result.effect);
    return {
      disposition: { kind: 'handled' },
      ...(callbackText ? { callbackText } : {}),
    };
  }

  private async applyEffect(
    entry: RemoteQuestionEntry,
    previous: RemoteQuestionStepState,
    effect: ReturnType<typeof applyRemoteQuestionStep>['effect'],
  ): Promise<string | undefined> {
    switch (effect.kind) {
      case 'rerender': {
        const noteChanged = previous.notes[previous.step] !== entry.state.notes[entry.state.step];
        if (previous.freeTextStep !== undefined && entry.state.freeTextStep === undefined) {
          await this.deleteTextPrompt(entry);
        }
        await this.replaceCurrentKeyboard(entry, noteChanged);
        return undefined;
      }
      case 'needNote': {
        await this.deleteTextPrompt(entry);
        const ids = await this.sendNotice(
          entry.chatId,
          renderRemoteQuestionNotePrompt(entry.state),
        );
        if (!ids) {
          entry.state = previous;
          return 'Forge could not start note entry. Try Note… again.';
        }
        entry.textPromptIds = ids;
        return undefined;
      }
      case 'sendStep':
        await this.finishCurrentStep(entry, previous);
        await this.sendStep(entry, effect.step);
        return undefined;
      case 'settle':
        if (!this.host.answerQuestionStructured(entry.event.id, effect.answer)) {
          return 'This question has already been answered.';
        }
        return undefined;
      case 'skip':
        entry.skipReceipt = true;
        if (!this.host.skipQuestion(entry.event.id)) {
          entry.skipReceipt = false;
          return 'This question has already been answered.';
        }
        return undefined;
      case 'toast':
        return effect.text;
    }
  }

  private async answerTextForEntry(entry: RemoteQuestionEntry, text: string): Promise<void> {
    if (this.questions.get(entry.event.id) !== entry) return;
    const spec = entry.state.specs[entry.state.step]!;
    const noteMode = entry.state.freeTextStep === entry.state.step;
    const input = applyRemoteQuestionText(
      entry.state,
      text,
      this.channel.name === 'telegram' && spec.options.length > 0,
      !entry.messageId,
    );
    if (input.kind === 'plain') {
      // Raw text: the host resolves numbers and labels once. Resolving here too
      // re-read an already-resolved numeric label as an index.
      this.host.answerQuestion(entry.event.id, text);
      return;
    }
    const { previous, result } = input;
    if (result.effect.kind === 'toast') {
      await this.refuseProse(entry, result.effect.text);
      return;
    }
    entry.state = result.state;
    if (result.effect.kind === 'rerender') {
      if (noteMode) await this.deleteTextPrompt(entry);
      await this.replaceCurrentKeyboard(entry, noteMode);
    } else {
      await this.applyEffect(entry, previous, result.effect);
    }
  }
  private async replaceCurrentKeyboard(
    entry: RemoteQuestionEntry,
    editText: boolean,
  ): Promise<void> {
    const messageId = entry.messageId;
    if (!messageId) {
      if (editText) await this.updateCurrentText(entry);
      return;
    }
    const replace = this.channel.replaceInlineKeyboard;
    if (!replace) throw new Error('Telegram question keyboard updates are unavailable.');
    if (editText) await this.updateCurrentText(entry);
    await replace.call(this.channel, entry.chatId, messageId, this.keyboard(entry), {
      signal: this.signal,
    });
  }

  private async updateCurrentText(entry: RemoteQuestionEntry): Promise<void> {
    const messageId = entry.messageId;
    if (!messageId || !this.channel.editMessage) return;
    const text = renderRemoteQuestionStep(entry.state);
    await this.channel.editMessage(entry.chatId, messageId, text, { signal: this.signal });
    entry.messageTexts.set(messageId, text);
  }

  private keyboard(entry: RemoteQuestionEntry) {
    return buildRemoteQuestionKeyboard(entry.event.id, entry.state);
  }

  private async sendStep(entry: RemoteQuestionEntry, step: number): Promise<void> {
    if (this.questions.get(entry.event.id) !== entry || entry.state.step !== step) return;
    const send = this.channel.sendInlineKeyboard;
    if (!send) {
      await this.failDelivery(entry, 'Telegram inline choices are unavailable.');
      return;
    }
    const text = renderRemoteQuestionStep(entry.state, step);
    try {
      const messageId = await send.call(
        this.channel,
        entry.chatId,
        text.slice(0, this.maxMessageChars),
        this.keyboard(entry),
        { signal: this.signal },
      );
      if (!messageId) {
        await this.failDelivery(entry, 'Telegram did not return the question message id.');
        return;
      }
      if (this.questions.get(entry.event.id) !== entry) {
        await this.channel.clearInlineKeyboard?.(entry.chatId, messageId, { signal: this.signal });
        return;
      }
      entry.delivered = true;
      entry.messageId = messageId;
      entry.messageTexts.set(messageId, text.slice(0, this.maxMessageChars));
    } catch (err) {
      await this.failDelivery(entry, err instanceof Error ? err.message : String(err));
    }
  }

  private async finishCurrentStep(
    entry: RemoteQuestionEntry,
    previous: RemoteQuestionStepState,
  ): Promise<void> {
    const messageId = entry.messageId;
    if (!messageId) return;
    entry.messageId = undefined;
    await this.channel.clearInlineKeyboard?.(entry.chatId, messageId, { signal: this.signal });
    const text = renderRemoteQuestionStepReceipt(previous, previous.step).slice(
      0,
      this.maxMessageChars,
    );
    await this.editMessage(entry, messageId, text);
  }

  private async failDelivery(entry: RemoteQuestionEntry, detail: string): Promise<void> {
    if (this.questions.get(entry.event.id) !== entry) return;
    entry.messageId = undefined;
    const step = entry.state.step;
    const text = renderRemoteQuestionStep(entry.state, step);
    try {
      const ids = await this.channel.send(entry.chatId, text.slice(0, this.maxMessageChars), {
        signal: this.signal,
      });
      for (const id of ids ?? []) entry.messageTexts.set(id, text.slice(0, this.maxMessageChars));
      entry.delivered = true;
    } catch (err) {
      this.report(`question delivery failed (${detail})`, err);
    }
  }

  private onAsked(event: UserQuestionRequestEvent): void {
    if (!event.conversationId) return;
    const chatId = this.chatFor(event.conversationId);
    if (!chatId) return;
    const entry: RemoteQuestionEntry = {
      chatId,
      event,
      state: createRemoteQuestionStepState(event.specs),
      messageTexts: new Map(),
      delivered: false,
      skipReceipt: false,
      callbackIds: new Set(),
      actionQueue: Promise.resolve(),
    };
    this.questions.set(event.id, entry);
    void this.enqueue(entry, () => this.publish(event.id));
  }

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
    const entry = this.questions.get(event.id);
    if (!entry) return;
    this.questions.delete(event.id);
    entry.state = applyRemoteQuestionStep(entry.state, { type: 'resolved' }).state;
    void this.closeMessages(entry, event);
    void this.deleteTextPrompt(entry);
    void this.publishResolution(entry, event);
  }

  private async publish(id: string): Promise<void> {
    const entry = this.questions.get(id);
    if (!entry || entry.delivered) return;
    if (!(await this.auth.canDeliver(this.channel.name, entry.chatId))) return;
    if (this.questions.get(id) !== entry) return;
    const canUseTelegramChoices = entry.state.specs.every(
      (spec) => spec.options.length > 0 && spec.options.length <= 99,
    );
    if (this.channel.name === 'telegram' && canUseTelegramChoices) {
      await this.sendStep(entry, entry.state.step);
      return;
    }
    const body =
      entry.state.specs.length === 1
        ? renderQuestionAsText(entry.event.prompt, entry.state.specs[0]!)
        : renderQuestionAsText(entry.event.prompt, undefined, entry.state.specs);
    try {
      const ids = await this.channel.send(
        entry.chatId,
        `Forge asks: ${body}`.slice(0, this.maxMessageChars),
        { signal: this.signal },
      );
      for (const messageId of ids ?? []) {
        entry.messageTexts.set(messageId, `Forge asks: ${body}`.slice(0, this.maxMessageChars));
      }
      entry.delivered = true;
    } catch (err) {
      this.report('question delivery failed', err);
    }
  }

  private async editMessage(
    entry: RemoteQuestionEntry,
    messageId: string,
    text: string,
  ): Promise<void> {
    await this.channel.editMessage?.(entry.chatId, messageId, text, { signal: this.signal });
    entry.messageTexts.set(messageId, text);
  }

  private async closeMessages(
    entry: RemoteQuestionEntry,
    event: UserQuestionAnsweredEvent,
  ): Promise<void> {
    const status = entry.skipReceipt
      ? 'Forge: skipped'
      : event.reason === 'answered'
        ? 'Forge: answered elsewhere.'
        : 'Forge: the question was dismissed without an answer.';
    for (const messageId of entry.messageTexts.keys()) {
      try {
        await this.channel.clearInlineKeyboard?.(entry.chatId, messageId, { signal: this.signal });
        const current = entry.messageTexts.get(messageId);
        if (current) await this.editMessage(entry, messageId, `${current}\n\n${status}`);
      } catch (err) {
        this.report('question keyboard cleanup', err);
      }
    }
    entry.messageId = undefined;
  }

  private async publishResolution(
    entry: RemoteQuestionEntry,
    event: UserQuestionAnsweredEvent,
  ): Promise<void> {
    if (!(await this.auth.canDeliver(this.channel.name, entry.chatId))) return;
    const text = entry.skipReceipt
      ? 'Forge: skipped'
      : event.reason === 'answered'
        ? `Forge: answered — “${(event.answer ?? '').slice(0, 800)}”`
        : 'Forge: the question was dismissed without an answer.';
    try {
      const sent = await this.channel.send(entry.chatId, text, { signal: this.signal });
      if (event.reason === 'answered') this.cleanup?.armEphemeral(entry.chatId, sent ?? []);
    } catch (err) {
      this.report('question resolution notice', err);
    }
  }

  private async refuseProse(entry: RemoteQuestionEntry, detail?: string): Promise<void> {
    const step =
      entry.state.specs.length > 1
        ? ` question ${entry.state.step + 1} of ${entry.state.specs.length}`
        : ' this question';
    const message = detail
      ? `Forge is waiting on${step}. ${detail} Your message was not sent to the agent.`
      : `Forge is waiting on${step}. Tap a choice, or Note… to type an answer — your message was not sent to the agent.`;
    const ids = await this.sendNotice(entry.chatId, message);
    this.cleanup?.armEphemeral(entry.chatId, ids ?? []);
  }

  private async sendNotice(chatId: string, text: string): Promise<string[] | undefined> {
    try {
      const sent = await this.channel.send(chatId, text.slice(0, this.maxMessageChars), {
        signal: this.signal,
      });
      return sent ?? undefined;
    } catch (err) {
      this.report('question notice', err);
      return undefined;
    }
  }

  private async deleteTextPrompt(entry: RemoteQuestionEntry): Promise<void> {
    const ids = entry.textPromptIds ?? [];
    delete entry.textPromptIds;
    for (const id of ids) {
      try {
        await this.channel.deleteMessage?.(entry.chatId, id, { signal: this.signal });
      } catch (err) {
        this.report('question note prompt cleanup', err);
      }
    }
  }

  private enqueue<T>(entry: RemoteQuestionEntry, operation: () => Promise<T>): Promise<T> {
    const current = entry.actionQueue.then(operation);
    entry.actionQueue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private report(operation: string, err: unknown): void {
    this.onError?.(
      `Forge remote ${operation}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function rejected(reason: string): ActionOutcome {
  return {
    disposition: { kind: 'rejected', reason },
    callbackText: 'This question is no longer active.',
  };
}
