import * as vscode from 'vscode';
import { z } from 'zod';
import {
  formatStructuredAnswer,
  normalizeQuestions,
  renderQuestionAsText,
  resolveAnswerText,
  type QuestionGroup,
  type QuestionOption,
  type QuestionSpec,
  type StructuredAnswer,
} from '../util/questionAnswers';
import { isAnswered } from '../util/questionPicks';

export interface UserQuestionRequestEvent {
  id: string;
  prompt: string;
  /** Every question normalized; a flat `options` list arrives as one spec. */
  specs: readonly QuestionSpec[];
  placeholder?: string;
  conversationId?: string;
}

export interface UserQuestionAnsweredEvent extends UserQuestionRequestEvent {
  answer: string | undefined;
  reason: 'answered' | 'cancelled';
}

export interface UserQuestionSink {
  asked(event: UserQuestionRequestEvent): void;
  answered(event: UserQuestionAnsweredEvent): void;
  /**
   * Whether this sink is rendering the question in front of the user AT THE
   * MACHINE right now -- the sidebar webview, in practice.
   *
   * When one says yes, the VS Code input box is not raised at all. The box was
   * the original and only local surface, which is why a multiple-choice
   * question opened the command palette's quick pick over the editor instead of
   * appearing in the sidebar where the rest of the turn is. It stays as the
   * fallback for a window whose sidebar view has never been resolved, so a
   * question is never asked into a void.
   */
  presentsLocally?(): boolean;
}

export interface UserQuestion {
  prompt: string;
  placeholder?: string | undefined;
  specs?: readonly QuestionSpec[] | undefined;
  /** Shorthand for `specs`, normalized by `normalizeQuestions`. */
  options?: readonly string[] | undefined;
  questions?: readonly QuestionGroup[] | undefined;
  conversationId?: string | undefined;
  signal?: AbortSignal | undefined;
}

interface PendingQuestion extends UserQuestionRequestEvent {
  settle: (answer: string | undefined, reason: 'answered' | 'cancelled') => void;
}

interface QuestionPickItem extends vscode.QuickPickItem {
  questionKind: 'option' | 'write';
  optionIndex?: number;
}

/**
 * The single owner of a question asked by the agent.
 *
 * ask_user used to talk straight to vscode.window, which made every question a
 * desktop-only event: a turn driven from Telegram raised a box nobody was
 * looking at. The question lives here instead, transport-neutral, and the local
 * input box and any remote sink race to answer it -- so the same tool call
 * works whichever surface started the turn.
 */
export class UserQuestionService {
  private readonly pending = new Map<string, PendingQuestion>();
  private readonly sinks = new Set<UserQuestionSink>();

  addSink(sink: UserQuestionSink): { dispose(): void } {
    this.sinks.add(sink);
    return { dispose: () => this.sinks.delete(sink) };
  }

  /** True while this conversation has a question waiting for an answer. */
  hasPending(conversationId: string): boolean {
    for (const question of this.pending.values()) {
      if (question.conversationId === conversationId) return true;
    }
    return false;
  }

  pendingConversationIds(): Set<string> {
    const ids = new Set<string>();
    for (const question of this.pending.values()) {
      ids.add(question.conversationId ?? '');
    }
    return ids;
  }

  /** Snapshot all pending requests in their original ask order for webviewReady. */
  pendingQuestions(): UserQuestionRequestEvent[] {
    return [...this.pending.values()].map(eventOf);
  }

  ask(request: UserQuestion): Promise<string | undefined> {
    if (request.signal?.aborted) return Promise.resolve(undefined);
    const specs =
      request.specs ??
      normalizeQuestions({
        prompt: request.prompt,
        ...(request.options ? { options: request.options } : {}),
        ...(request.questions ? { questions: request.questions } : {}),
      });
    const normalizedRequest: UserQuestion = { ...request, specs };

    const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise<string | undefined>((resolve) => {
      let done = false;
      // First writer wins, from whichever surface. Every path disposes the
      // desktop box, so a question answered from Telegram does not leave a
      // stale prompt sitting open over an answer that already arrived.
      const settle = (answer: string | undefined, reason: 'answered' | 'cancelled'): void => {
        if (done) return;
        done = true;
        this.pending.delete(id);
        input.dispose();
        const event: UserQuestionAnsweredEvent = { ...eventOf(entry), answer, reason };
        for (const sink of this.sinks) sink.answered(event);
        resolve(answer);
      };

      const entry: PendingQuestion = {
        id,
        prompt: request.prompt,
        specs,
        settle,
        ...(request.placeholder !== undefined ? { placeholder: request.placeholder } : {}),
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      };
      this.pending.set(id, entry);
      // Raised before the abort listener and the sinks, so both of those paths
      // find a box to dispose: either can settle the question the moment it is
      // published, and a stale prompt must never outlive its answer. A sink
      // that presents locally makes this a no-op disposable rather than a box.
      const input = this.presentedLocally()
        ? new vscode.Disposable(() => {})
        : this.showLocal(
            normalizedRequest,
            (text) => settle(text, 'answered'),
            () => settle(undefined, 'cancelled'),
          );
      request.signal?.addEventListener('abort', () => settle(undefined, 'cancelled'), {
        once: true,
      });
      for (const sink of this.sinks) sink.asked(eventOf(entry));
    });
  }

  /** Resolves typed text using the pending spec and exact-label-first rules. */
  answer(id: string, text: string): boolean {
    const question = this.pending.get(id);
    if (!question) return false;
    question.settle(resolveSpecsAnswer(text, question.specs), 'answered');
    return true;
  }

  /** Validates option indexes and notes before settling a structured answer. */
  answerStructured(id: string, answer: StructuredAnswer): boolean {
    const question = this.pending.get(id);
    if (!question) return false;
    const result = validateStructuredAnswer(question.specs, answer);
    if (!result.success) {
      // eslint-disable-next-line no-console -- Invalid host payloads must be visible for diagnosis.
      console.error('Forge: rejected invalid structured question answer', result.error.issues);
      return false;
    }
    question.settle(formatStructuredAnswer(question.specs, answer), 'answered');
    return true;
  }

  /** Settles with the explicit skip instruction, distinct from cancellation. */
  skip(id: string): boolean {
    const question = this.pending.get(id);
    if (!question) return false;
    question.settle(
      formatStructuredAnswer(question.specs, { skipped: true, answers: [] }),
      'answered',
    );
    return true;
  }

  /**
   * Dismisses a pending question without an answer (an aborted turn).
   *
   * Separate from `skip`: the tool reports a dismissal as "the user did not
   * answer", while a skip is the user's explicit choice and tells the model to
   * proceed on a stated assumption. False when the question is already gone.
   */
  dismiss(id: string): boolean {
    const question = this.pending.get(id);
    if (!question) return false;
    question.settle(undefined, 'cancelled');
    return true;
  }

  private presentedLocally(): boolean {
    for (const sink of this.sinks) {
      if (sink.presentsLocally?.()) return true;
    }
    return false;
  }

  private showLocal(
    request: UserQuestion,
    accept: (text: string) => void,
    dismiss: () => void,
  ): vscode.Disposable {
    // createInputBox/createQuickPick rather than the show* wrappers: only these
    // can be hidden programmatically when a remote answer wins the race.
    //
    // Several questions get the box, not the picker: a quick pick answers
    // exactly one list, and chaining several would leave the earlier ones
    // unanswerable once the user moved on. The box takes all of them at once
    // as numbers, the same reply a chat would send.
    const specs = request.specs ?? normalizeQuestions({ prompt: request.prompt });
    if (specs.length > 1) {
      const box = vscode.window.createInputBox();
      let completing = false;
      box.prompt = renderQuestionAsText(request.prompt, undefined, specs);
      box.ignoreFocusOut = true;
      box.onDidAccept(() => {
        if (!box.value.trim()) return;
        const answer = resolveSpecsAnswer(box.value, specs);
        completing = true;
        box.dispose();
        accept(answer);
      });
      box.onDidHide(() => {
        if (!completing) dismiss();
      });
      box.show();
      return box;
    }

    const spec = specs[0]!;
    if (!spec.options.length) return this.showLocalText(request, specs, accept, dismiss, []);

    const picker = vscode.window.createQuickPick<QuestionPickItem>();
    picker.items = [
      ...spec.options.map((option, optionIndex) => ({
        label: option.label,
        ...optionDescription(option),
        questionKind: 'option' as const,
        optionIndex,
      })),
      {
        label: 'Write my own answer…',
        description: 'Type a response instead',
        questionKind: 'write',
        alwaysShow: true,
      },
    ];
    picker.canSelectMany = spec.multiSelect;
    picker.placeholder = spec.prompt;
    picker.ignoreFocusOut = true;
    let completing = false;
    let active: vscode.Disposable = picker;
    picker.onDidAccept(() => {
      const selected = picker.selectedItems;
      const picks = selected
        .filter((item) => item.questionKind === 'option' && item.optionIndex !== undefined)
        .map((item) => item.optionIndex!)
        .sort((a, b) => a - b);
      const writeOwn = selected.some((item) => item.questionKind === 'write');
      if (!picks.length && !writeOwn) return;
      completing = true;
      picker.dispose();
      if (writeOwn) {
        active = this.showLocalText(request, specs, accept, dismiss, picks);
      } else {
        accept(formatStructuredAnswer(specs, { answers: [{ picks }] }));
      }
    });
    picker.onDidHide(() => {
      if (!completing) dismiss();
    });
    picker.show();
    return new vscode.Disposable(() => active.dispose());
  }

  private showLocalText(
    request: UserQuestion,
    specs: readonly QuestionSpec[],
    accept: (text: string) => void,
    dismiss: () => void,
    picks: number[],
  ): vscode.InputBox {
    const box = vscode.window.createInputBox();
    const spec = specs[0]!;
    box.prompt = spec.prompt || request.prompt;
    box.placeholder =
      request.placeholder ?? (spec.options.length ? 'Add a note (optional)' : 'Your answer…');
    // Without this the box is dismissed the moment focus moves -- it is raised
    // mid-turn while the sidebar streams -- and the question is never seen.
    box.ignoreFocusOut = true;
    let completing = false;
    box.onDidAccept(() => {
      const note = box.value;
      if (!isAnswered(picks, note)) return;
      completing = true;
      box.dispose();
      const answer =
        specs.length === 1
          ? formatStructuredAnswer(specs, {
              answers: [{ picks, ...(note.trim() ? { note } : {}) }],
            })
          : resolveSpecsAnswer(note, specs);
      accept(answer);
    });
    box.onDidHide(() => {
      if (!completing) dismiss();
    });
    box.show();
    return box;
  }
}

/** The quick pick's dim text; the label stays bare because it is the answer. */
function optionDescription(option: QuestionOption): { description?: string } {
  const parts = [option.recommended ? 'Recommended' : '', option.description ?? ''].filter(Boolean);
  return parts.length ? { description: parts.join(' · ') } : {};
}

function resolveSpecsAnswer(text: string, specs: readonly QuestionSpec[]): string {
  return specs.length === 1
    ? resolveAnswerText(text, specs[0]!)
    : resolveAnswerText(text, undefined, specs);
}

function validateStructuredAnswer(
  specs: readonly QuestionSpec[],
  answer: StructuredAnswer,
): ReturnType<ReturnType<typeof structuredAnswerSchema>['safeParse']> {
  return structuredAnswerSchema(specs).safeParse(answer);
}

function structuredAnswerSchema(specs: readonly QuestionSpec[]) {
  const answer = z
    .object({
      picks: z.array(z.number().int().min(0)),
      note: z.string().max(4000).optional(),
    })
    .strict();
  return z
    .object({
      skipped: z.literal(true).optional(),
      answers: z.array(answer).length(specs.length),
    })
    .strict()
    .superRefine((value, context) => {
      value.answers.forEach((entry, questionIndex) => {
        const spec = specs[questionIndex]!;
        // The card keeps Answer disabled until every question is answered; a
        // payload that slips past it must not reach the model as a blank line.
        if (!isAnswered(entry.picks, entry.note)) {
          context.addIssue({
            code: 'custom',
            path: ['answers', questionIndex],
            message: 'Question is unanswered.',
          });
        }
        const seen = new Set<number>();
        entry.picks.forEach((pick, pickIndex) => {
          if (pick >= spec.options.length) {
            context.addIssue({
              code: 'custom',
              path: ['answers', questionIndex, 'picks', pickIndex],
              message: 'Option index is out of range.',
            });
          }
          if (seen.has(pick)) {
            context.addIssue({
              code: 'custom',
              path: ['answers', questionIndex, 'picks', pickIndex],
              message: 'Option indexes must be unique.',
            });
          }
          seen.add(pick);
        });
      });
    });
}

function eventOf(question: PendingQuestion): UserQuestionRequestEvent {
  return {
    id: question.id,
    prompt: question.prompt,
    specs: question.specs,
    ...(question.placeholder !== undefined ? { placeholder: question.placeholder } : {}),
    ...(question.conversationId ? { conversationId: question.conversationId } : {}),
  };
}
