import { ephemeralRejection } from './RemoteEphemeralMessages';
import type { RemoteCommandContext } from './RemoteCommandHandler';
import { handleRemoteCommand } from './RemoteCommandHandler';
import {
  admitRemoteText,
  isRemoteCommand,
  type RemotePromptAdmissionDeps,
} from './RemotePromptAdmission';
import { remoteDedupKey } from './RemoteRequestStore';
import { admitRemoteSessionCommand, admitRemoteSessionReply } from './remoteSessionAdmission';
import { resolveVoiceDraft, type VoiceBridgeBundle } from './RemoteVoiceBridge';
import type { RemoteInboundDisposition, RemoteInboundEvent } from './types';

type TextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;

export interface RemoteTextRoutingDeps {
  maxMessageChars: number;
  promptDeps: RemotePromptAdmissionDeps;
  acknowledge: (chatId: string, text: string) => Promise<void>;
  onError?: ((message: string) => void) | undefined;
  /** An open ask_user question claims plain text; true when it did. */
  answerQuestion: (chatId: string, text: string) => boolean;
  voice?: VoiceBridgeBundle | undefined;
  say: (chatId: string, text: string) => Promise<void>;
  /** Re-enters the full inbound path, gates included. */
  rerun: (event: RemoteInboundEvent) => Promise<RemoteInboundDisposition>;
  touch: (event: RemoteInboundEvent) => void;
  commandContext: (event: TextEvent) => RemoteCommandContext;
  scheduleCommandCleanup: (event: TextEvent) => void;
}

/**
 * Who owns an authenticated text message, in priority order: a reply to a
 * session question, an open ask_user question, a pending voice draft, a session
 * command, an owner command, and finally a prompt for the bound conversation.
 */
export async function routeRemoteText(
  event: TextEvent,
  deps: RemoteTextRoutingDeps,
): Promise<RemoteInboundDisposition> {
  const touched = (result: RemoteInboundDisposition): RemoteInboundDisposition => {
    if (result.kind !== 'rejected' && result.kind !== 'retry') deps.touch(event);
    return result;
  };
  if (event.text.length > deps.maxMessageChars) {
    return ephemeralRejection('message exceeds configured limit');
  }
  const reply = await admitRemoteSessionReply(event, deps.promptDeps, deps.acknowledge);
  if (reply) return reply;
  if (!event.text.startsWith('/') && deps.answerQuestion(event.chatId, event.text)) {
    return touched({ kind: 'handled' });
  }
  // Questions take priority over voice drafts.
  const draftResult = deps.voice
    ? await resolveVoiceDraft(event, deps.voice, {
        touch: () => deps.touch(event),
        say: (text) => deps.say(event.chatId, text),
        rerun: (text) => deps.rerun({ ...event, text }),
      })
    : undefined;
  if (draftResult) return draftResult;
  const key = remoteDedupKey(event.channel, event.chatId, event.providerMessageId);
  const sessionAsk = await admitRemoteSessionCommand(
    event,
    key,
    deps.promptDeps,
    deps.acknowledge,
    deps.onError,
  );
  if (sessionAsk) return touched(sessionAsk);
  if (isRemoteCommand(event.text)) {
    const result = touched(await handleRemoteCommand(event, deps.commandContext(event), key));
    if (result.kind === 'handled' || result.kind === 'rejected') {
      deps.scheduleCommandCleanup(event);
    }
    return result;
  }
  return touched(await admitRemoteText(event, key, deps.promptDeps));
}
