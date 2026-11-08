import type { ConversationRuntime } from './sessionTypes';
import type { HostActivityEvent } from './HostActivity';
import type { SidebarProviderEvents } from './AgentLoop';
import type { TurnSpeedLedger } from '../sessions/turnSpeedTotals';
import type { HostToWebview } from './messageBridge';
import type { WebviewActions } from './webviewMessageRouter';
import type { AgentProgressEvent } from './AgentProgress';

/** Telegram's own cap is 4096; leave room for the prefix and an ellipsis. */
const MAX_MIRRORED_CHARS = 3_500;
const MAX_MIRRORED_PROMPT_CHARS = 500;

/** Clip prompt text to the same limit used by every mirrored sidebar prompt. */
export function clipMirroredPrompt(text: string): string {
  return text.length > MAX_MIRRORED_PROMPT_CHARS
    ? `${text.slice(0, MAX_MIRRORED_PROMPT_CHARS - 1)}…`
    : text;
}

export interface TurnMirrorWiring {
  lookup: (conversationId: string) => ConversationRuntime | undefined;
  emit: (event: HostActivityEvent) => void;
  /**
   * Closes the progress channel for the turn.
   *
   * Separate from `emit` because it must fire on every ending, including the
   * one `emit` has nothing to say about: a turn that produced no answer sends
   * no activity event, and a live progress message with no closer stays on
   * "working…" for good.
   */
  endProgress: (conversationId: string, ok: boolean) => void;
  /**
   * True when the post-turn auto-compaction will pick this failure up and
   * resume it. Telling the user "nothing further is running" and then resuming
   * a minute later is what made the 2026-09-15 Telegram thread contradict itself.
   */
  willAutoResume?: (failureMessage: string) => boolean;
  /**
   * This turn's server timings, summed by the turn runner as its requests settle.
   *
   * Decorated here because this is the one place that knows when a turn began
   * and when it ended: the sums have to be opened and closed at those two
   * moments, and a failed turn has to drop them rather than leave them for the
   * next answer to wear.
   */
  turnSpeeds: TurnSpeedLedger;
}

/** Emit the sidebar prompt before SendPipeline can start this turn's progress. */
export function emitWebviewPrompt(
  emit: (event: HostActivityEvent) => void,
  conversationId: string,
  text: string,
  attachmentCount: number,
): void {
  if (!text.trim() || text.startsWith('/')) return;
  const prompt = clipMirroredPrompt(text);
  const attachments = attachmentCount > 0 ? ` [+${attachmentCount} attachments]` : '';
  emit({
    text: `You (VS Code): ${prompt}${attachments}`,
    conversationId,
    kind: 'prompt',
  });
}

/** Mirror a webview send synchronously before routing can start turn progress. */
export function createWebviewSendAction(
  emit: (event: HostActivityEvent) => void,
  activeConversationId: () => string,
  route: WebviewActions['send'],
): WebviewActions['send'] {
  return (text, attachments, conversationId, tellId, createdAt) => {
    emitWebviewPrompt(
      emit,
      conversationId ?? activeConversationId(),
      text,
      attachments?.length ?? 0,
    );
    if (createdAt === undefined) route(text, attachments, conversationId, tellId);
    else route(text, attachments, conversationId, tellId, createdAt);
  };
}

/**
 * Echo a turn's outcome — answer or failure — to the chats bound to it.
 *
 * Decorates `onGenerationFinished` the way wireSessionTimer does, for the same
 * reason: the event already fires at exactly the right moment and carries the
 * conversationId, so the alternative is a second event firing beside it.
 *
 * This fires for EVERY turn, including ones a remote chat asked for.
 * De-duplication is not attempted here on purpose — the fact that decides it
 * is "does a remote progress message already own this turn", which only
 * RemoteAgentProgress knows. RemoteController.mirrorTurn asks it there.
 * Guessing at origin from this side would mean threading a flag through the
 * whole turn path to answer the same question worse.
 */
export function wireTurnMirror(events: SidebarProviderEvents, deps: TurnMirrorWiring): void {
  // The turn's speed sums open and close with the turn, on the same events that
  // already mark its beginning and its end.
  const originalStarted = events.onGenerationStarted;
  events.onGenerationStarted = (modelName, conversationId) => {
    originalStarted?.(modelName, conversationId);
    if (conversationId === undefined) return;
    // Anything left from a turn that never ended — a crash, a window closed
    // mid-request — belongs to no answer, so it is dropped here instead of
    // riding into this turn's line.
    deps.turnSpeeds.beginTurn(conversationId);
  };

  const original = events.onGenerationFinished;
  events.onGenerationFinished = (modelName, conversationId, finalText) => {
    original?.(modelName, conversationId, finalText);
    if (conversationId === undefined) return;
    // The provider already has the exact final answer at this point. Reading
    // the transcript here was racy around cold backend startup/restart: a
    // session sync or a continuation could make the callback see a different
    // tail even though the turn had just completed successfully.
    const text = finalText?.trim() || finalAnswer(deps.lookup(conversationId));
    if (!text) {
      // A turn with no answer has no reply to carry a speed line, so the sums
      // are dropped rather than kept for something that will never be sent.
      deps.turnSpeeds.abandonTurn(conversationId);
      deps.endProgress(conversationId, true);
      return;
    }
    const line = deps.turnSpeeds.finishTurn(conversationId);
    // The line travels beside the text, never inside it: the text is what
    // becomes the conversation's message, the transcript and the model's next
    // request, and a model that reads its own speed lines starts writing them.
    deps.emit({
      text,
      conversationId,
      kind: 'turn',
      ...(line ? { speedLine: line } : {}),
    });
    deps.endProgress(conversationId, true);
  };

  // A failed turn fires onGenerationFinished too, but with no final text — so
  // the branch above sends nothing and the chat is left watching a turn that
  // will never speak again. Decorated here rather than emitted from the turn
  // path for the same reason as the answer: one place subscribes the outbound
  // hooks.
  const originalFailed = events.onTurnFailed;
  events.onTurnFailed = (conversationId, message) => {
    originalFailed?.(conversationId, message);
    if (conversationId === undefined) return;
    deps.endProgress(conversationId, false);
    // No answer, no line: a turn that died leaves no sums behind for the next
    // answer of the same chat to wear as its own speed.
    deps.turnSpeeds.abandonTurn(conversationId);
    const next = deps.willAutoResume?.(message)
      ? 'Forge will compact the context and resume the task automatically.'
      : 'Nothing further is running. Send a new instruction to pick it back up.';
    deps.emit({
      text: `Forge: the turn stopped — ${message}

${next}`,
      conversationId,
      kind: 'failure',
    });
  };
}

/**
 * The progress row a posted webview message should also produce, if any, so a
 * paired chat sees what the sidebar sees.
 *
 * Applied by decorating the provider's `post` rather than the emit sites, the
 * same technique `wireTurnMirror` uses on `onGenerationFinished`: notices are
 * raised from 12 places and mid-turn errors from 27, and threading a mirror
 * call through each would leave the next new one silent by default.
 *
 * Only *addressed* messages are mirrored. An unaddressed notice would have to be
 * attributed to the active tab, which is right in the webview and wrong here --
 * a background conversation's chat would be told about a turn not its own.
 */
export function statusRowProgress(
  msg: HostToWebview,
  isStreaming: (conversationId: string) => boolean,
): AgentProgressEvent | undefined {
  if (msg.type === 'notice') {
    if (!msg.conversationId) return undefined;
    return {
      conversationId: msg.conversationId,
      kind: 'notice',
      text: msg.message,
      severity: msg.severity ?? 'info',
    };
  }
  if (msg.type !== 'error' || !msg.conversationId) return undefined;
  // A turn that actually fails is already mirrored by wireTurnMirror. What is
  // missing is the error posted *while the turn continues* -- the repeated tool
  // call guard is the clearest case, and it ends the useful part of the turn
  // while saying nothing remotely.
  if (!isStreaming(msg.conversationId)) return undefined;
  return {
    conversationId: msg.conversationId,
    kind: 'notice',
    text: msg.message,
    severity: 'warning',
  };
}

/**
 * The last assistant text in the transcript.
 *
 * Walks backwards rather than reading the final element: a turn ends with tool
 * rows after the answer often enough that indexing the end would mirror an
 * empty string. A turn that produced only tool calls has no answer to send,
 * and returns undefined rather than an empty message.
 */
function finalAnswer(conv: ConversationRuntime | undefined): string | undefined {
  if (!conv) return undefined;
  for (let index = conv.messages.length - 1; index >= 0; index -= 1) {
    const message = conv.messages[index]!;
    if (message.role === 'user') return undefined;
    if (message.role !== 'assistant') continue;
    // A round that ended in tool calls was narrated as it happened. When the
    // last such round is all a turn has (the user stopped it), echoing it here
    // delivered the same paragraph twice; that turn has no final answer.
    if (message.tool_calls?.length) return undefined;
    if (typeof message.content !== 'string') continue;
    const text = message.content.trim();
    if (!text) continue;
    return text.length > MAX_MIRRORED_CHARS
      ? `${text.slice(0, MAX_MIRRORED_CHARS)}\n\n… (truncated; see the Forge window)`
      : text;
  }
  return undefined;
}
