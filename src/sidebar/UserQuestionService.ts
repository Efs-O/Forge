import * as vscode from 'vscode';
import {
  renderQuestionAsText,
  resolveAnswerText,
  type QuestionGroup,
} from '../util/questionAnswers';

export interface UserQuestionRequestEvent {
  id: string;
  prompt: string;
  placeholder?: string;
  options?: readonly string[];
  /**
   * Sub-questions, each with its own choice list, answered in one round.
   *
   * A single flat `options` list forced two decisions to be crossed into their
   * combinations -- four buttons for two yes/no choices -- which grows
   * multiplicatively and reads as one question the user has to decode. When
   * present, `options` is ignored.
   */
  questions?: readonly QuestionGroup[];
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
  options?: readonly string[] | undefined;
  questions?: readonly QuestionGroup[] | undefined;
  conversationId?: string | undefined;
  signal?: AbortSignal | undefined;
}

interface PendingQuestion extends UserQuestionRequestEvent {
  settle: (answer: string | undefined, reason: 'answered' | 'cancelled') => void;
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

  ask(request: UserQuestion): Promise<string | undefined> {
    if (request.signal?.aborted) return Promise.resolve(undefined);
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
        settle,
        ...(request.placeholder !== undefined ? { placeholder: request.placeholder } : {}),
        ...(request.options ? { options: request.options } : {}),
        ...(request.questions ? { questions: request.questions } : {}),
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
            request,
            (text) => settle(text, 'answered'),
            () => settle(undefined, 'cancelled'),
          );
      request.signal?.addEventListener('abort', () => settle(undefined, 'cancelled'), {
        once: true,
      });
      for (const sink of this.sinks) sink.asked(eventOf(entry));
    });
  }

  /** Answers a pending question from a non-local surface. False when it is gone. */
  answer(id: string, text: string): boolean {
    const question = this.pending.get(id);
    if (!question) return false;
    question.settle(resolveAnswerText(text, question.options, question.questions), 'answered');
    return true;
  }

  /**
   * Dismisses a pending question without an answer.
   *
   * Separate from `answer` because the two settle differently: the tool reports
   * a dismissal as "the user did not answer", and passing an empty string
   * through `answer` would instead hand the model a blank reply it reads as
   * one. False when the question is already gone.
   */
  dismiss(id: string): boolean {
    const question = this.pending.get(id);
    if (!question) return false;
    question.settle(undefined, 'cancelled');
    return true;
  }

  /** True while some sink is showing the question at the machine itself. */
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
    // Sub-questions get the box, not the picker: a quick pick answers exactly
    // one list, and chaining several would leave the earlier ones unanswerable
    // once the user moved on. The box takes all of them at once as numbers,
    // the same reply a chat would send.
    if (request.questions?.length) {
      const box = vscode.window.createInputBox();
      box.prompt = renderQuestionAsText(request.prompt, undefined, request.questions);
      box.ignoreFocusOut = true;
      box.onDidAccept(() => accept(resolveAnswerText(box.value, undefined, request.questions)));
      box.onDidHide(() => dismiss());
      box.show();
      return box;
    }
    if (request.options?.length) {
      const picker = vscode.window.createQuickPick();
      picker.items = request.options.map((label) => ({ label }));
      picker.placeholder = request.prompt;
      picker.ignoreFocusOut = true;
      picker.onDidAccept(() => {
        const selected = picker.selectedItems[0]?.label;
        if (selected !== undefined) accept(selected);
      });
      picker.onDidHide(() => dismiss());
      picker.show();
      return picker;
    }
    const box = vscode.window.createInputBox();
    box.prompt = request.prompt;
    if (request.placeholder !== undefined) box.placeholder = request.placeholder;
    // Without this the box is dismissed the moment focus moves -- it is raised
    // mid-turn while the sidebar streams -- and the question is never seen.
    box.ignoreFocusOut = true;
    box.onDidAccept(() => accept(box.value));
    box.onDidHide(() => dismiss());
    box.show();
    return box;
  }
}

function eventOf(question: PendingQuestion): UserQuestionRequestEvent {
  return {
    id: question.id,
    prompt: question.prompt,
    ...(question.placeholder !== undefined ? { placeholder: question.placeholder } : {}),
    ...(question.options ? { options: question.options } : {}),
    ...(question.questions ? { questions: question.questions } : {}),
    ...(question.conversationId ? { conversationId: question.conversationId } : {}),
  };
}
