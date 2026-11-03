import type {
  UserQuestionAnsweredEvent,
  UserQuestionRequestEvent,
} from '../sidebar/UserQuestionService';
import type { CommandCleanupScheduler } from './CommandCleanupScheduler';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteChannel } from './types';
import type { RemoteQuestionStepState } from './RemoteQuestionSteps';

/**
 * Everything one question has put on screen, and what it still owes them.
 *
 * `messageTexts` is the record of every message this question has shown — the
 * board, its later steps, a plain-text fallback — because answering has to
 * retire *all* of them, not only the one still carrying buttons.
 */
export interface RemoteQuestionEntry {
  chatId: string;
  /** The conversation whose turn asked; what the working line is keyed by. */
  conversationId: string;
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

/** The chat round-trip the question's non-board messages need. */
export interface RemoteQuestionMessageDeps {
  channel: RemoteChannel;
  auth: RemoteAuth;
  signal: AbortSignal;
  cleanup?: CommandCleanupScheduler;
  /** Read per call: the transport limit changes with a config reload. */
  maxMessageChars: () => number;
  report: (operation: string, err: unknown) => void;
}

/**
 * The messages a question sends around its board: the note prompt, the prose
 * refusal that explains why a typed message was not sent, the answered receipts
 * and the shared edit. The board itself and the arbitration of taps and typed
 * replies stay in `RemoteQuestionBridge`; this file only maintains what is
 * already on screen.
 */

/** Sends one line of its own and returns the ids, or nothing when it failed. */
export async function sendQuestionNotice(
  deps: RemoteQuestionMessageDeps,
  chatId: string,
  text: string,
): Promise<string[] | undefined> {
  try {
    const sent = await deps.channel.send(chatId, text.slice(0, deps.maxMessageChars()), {
      signal: deps.signal,
    });
    return sent ?? undefined;
  } catch (err) {
    deps.report('question notice', err);
    return undefined;
  }
}

/** Writes a question message's text and remembers it as what that message shows. */
export async function editQuestionMessage(
  deps: RemoteQuestionMessageDeps,
  entry: RemoteQuestionEntry,
  messageId: string,
  text: string,
): Promise<void> {
  await deps.channel.editMessage?.(entry.chatId, messageId, text, { signal: deps.signal });
  entry.messageTexts.set(messageId, text);
}

/** Deletes the "send your note" prompt a question no longer needs. */
export async function deleteQuestionTextPrompt(
  deps: RemoteQuestionMessageDeps,
  entry: RemoteQuestionEntry,
): Promise<void> {
  const ids = entry.textPromptIds ?? [];
  delete entry.textPromptIds;
  for (const id of ids) {
    try {
      await deps.channel.deleteMessage?.(entry.chatId, id, { signal: deps.signal });
    } catch (err) {
      deps.report('question note prompt cleanup', err);
    }
  }
}

/**
 * Why a typed message was not sent, and where to go instead. Deleted after the
 * command-reply delay: it is an explanation of a message the owner already
 * sent, not a record of what the agent did.
 */
export async function refuseQuestionProse(
  deps: RemoteQuestionMessageDeps,
  entry: RemoteQuestionEntry,
  detail?: string,
): Promise<void> {
  const step =
    entry.state.specs.length > 1
      ? ` question ${entry.state.step + 1} of ${entry.state.specs.length}`
      : ' this question';
  const message = detail
    ? `Forge is waiting on${step}. ${detail} Your message was not sent to the agent.`
    : `Forge is waiting on${step}. Tap a choice, or Note… to type an answer — your message was not sent to the agent.`;
  const ids = await sendQuestionNotice(deps, entry.chatId, message);
  deps.cleanup?.armEphemeral(entry.chatId, ids ?? []);
}

/**
 * Retires every message this question showed: buttons off, and the status of
 * the answer written on each one, so the chat keeps a record of what was asked
 * even after the choice was made elsewhere.
 */
export async function closeQuestionMessages(
  deps: RemoteQuestionMessageDeps,
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
      await deps.channel.clearInlineKeyboard?.(entry.chatId, messageId, { signal: deps.signal });
      const current = entry.messageTexts.get(messageId);
      if (current) await editQuestionMessage(deps, entry, messageId, `${current}\n\n${status}`);
    } catch (err) {
      deps.report('question keyboard cleanup', err);
    }
  }
  entry.messageId = undefined;
}

/**
 * Says what the answer was, as its own message below the board.
 *
 * An answered receipt is ephemeral: the board above it already carries the
 * `Forge: answered …` line, so this is the notification, not the record.
 */
export async function publishQuestionResolution(
  deps: RemoteQuestionMessageDeps,
  entry: RemoteQuestionEntry,
  event: UserQuestionAnsweredEvent,
): Promise<void> {
  if (!(await deps.auth.canDeliver(deps.channel.name, entry.chatId))) return;
  const text = entry.skipReceipt
    ? 'Forge: skipped'
    : event.reason === 'answered'
      ? `Forge: answered — “${(event.answer ?? '').slice(0, 800)}”`
      : 'Forge: the question was dismissed without an answer.';
  try {
    const sent = await deps.channel.send(entry.chatId, text, { signal: deps.signal });
    if (event.reason === 'answered') deps.cleanup?.armEphemeral(entry.chatId, sent ?? []);
  } catch (err) {
    deps.report('question resolution notice', err);
  }
}
