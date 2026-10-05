import type { RemoteInboundDisposition, RemoteInboundEvent } from './types';
import type { RemotePromptAdmissionDeps } from './RemotePromptAdmission';
import { admitRemotePrompt } from './RemotePromptAdmission';
import { remoteSessionAskFromText } from './remoteSessionTellCommands';
import { MAX_TELL_MESSAGE_CHARS } from '../tools/tellLiveSessionTool';
import { ephemeralRejection } from './RemoteEphemeralMessages';
import { answerRemoteSessionQuestion } from './RemoteSessionBridge';

/** Return undefined only when this is not an exact session command. */
export async function admitRemoteSessionCommand(
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  key: string,
  deps: RemotePromptAdmissionDeps,
  acknowledge: (chatId: string, text: string) => Promise<void>,
  onError?: (message: string) => void,
): Promise<RemoteInboundDisposition | undefined> {
  if (/^\/answer(?:\s|$)/u.test(event.text)) {
    const match = /^\/answer\s+([0-9a-f-]{36})\s+([\s\S]+)$/u.exec(event.text);
    if (!match) return ephemeralRejection('usage: /answer <question-id> <answer>');
    if (match[2]!.trim().length > MAX_TELL_MESSAGE_CHARS) {
      return ephemeralRejection(`answer exceeds ${MAX_TELL_MESSAGE_CHARS} characters`);
    }
    const outcome = await answerRemoteSessionQuestion(
      deps.store,
      event.channel,
      event.chatId,
      match[1]!,
      match[2]!,
    );
    if (outcome === 'answered') {
      try {
        await acknowledge(event.chatId, 'Forge: answer sent to the session.');
      } catch (error) {
        onError?.(`Forge session answer acknowledgement failed: ${String(error)}`);
      }
    }
    return outcome === 'missing'
      ? ephemeralRejection('that session question is unknown, expired or belongs to another chat')
      : { kind: 'handled' };
  }
  const ask = remoteSessionAskFromText(event.text);
  if (!ask) return undefined;
  if (!ask.message) return ephemeralRejection(`usage: /${ask.target} <message>`);
  if (ask.message.length > MAX_TELL_MESSAGE_CHARS) {
    return ephemeralRejection(
      `/${ask.target} message exceeds ${MAX_TELL_MESSAGE_CHARS} characters`,
    );
  }
  if (event.attachments?.length) return ephemeralRejection('session commands accept text only');
  const result = await admitRemotePrompt(event, ask.message, key, deps, ask.target);
  if (result.kind === 'accepted') {
    try {
      await acknowledge(event.chatId, `Forge: asking ${ask.target}; the answer will arrive here.`);
    } catch (error) {
      onError?.(`Forge session acknowledgement failed: ${String(error)}`);
    }
  }
  return result;
}
