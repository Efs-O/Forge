import * as vscode from 'vscode';

export interface UserQuestionRequestEvent {
  id: string;
  prompt: string;
  options?: readonly string[];
  conversationId?: string;
}

export interface UserQuestionAnsweredEvent extends UserQuestionRequestEvent {
  answer: string | undefined;
  reason: 'answered' | 'cancelled';
}

export interface UserQuestionSink {
  asked(event: UserQuestionRequestEvent): void;
  answered(event: UserQuestionAnsweredEvent): void;
}

export interface UserQuestion {
  prompt: string;
  placeholder?: string | undefined;
  options?: readonly string[] | undefined;
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

  pendingFor(conversationId: string): UserQuestionRequestEvent | undefined {
    for (const question of this.pending.values()) {
      if (question.conversationId === conversationId) return eventOf(question);
    }
    return undefined;
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
        ...(request.options ? { options: request.options } : {}),
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      };
      this.pending.set(id, entry);
      // Raised before the abort listener and the sinks, so both of those paths
      // find a box to dispose: either can settle the question the moment it is
      // published, and a stale prompt must never outlive its answer.
      const input = this.showLocal(
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
    question.settle(resolveSelection(text, question.options), 'answered');
    return true;
  }

  cancel(id: string): void {
    this.pending.get(id)?.settle(undefined, 'cancelled');
  }

  private showLocal(
    request: UserQuestion,
    accept: (text: string) => void,
    dismiss: () => void,
  ): vscode.Disposable {
    // createInputBox/createQuickPick rather than the show* wrappers: only these
    // can be hidden programmatically when a remote answer wins the race.
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
    ...(question.options ? { options: question.options } : {}),
    ...(question.conversationId ? { conversationId: question.conversationId } : {}),
  };
}

/** A bare index against an options list selects that option; anything else is verbatim. */
function resolveSelection(text: string, options?: readonly string[]): string {
  if (!options?.length) return text;
  const index = /^\s*([0-9]+)\s*$/.exec(text);
  if (!index) return text;
  const picked = options[Number(index[1]) - 1];
  return picked ?? text;
}
