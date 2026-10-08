import type { RemoteInboundDisposition, RemoteInboundEvent } from './types';
import type { RemotePromptAdmissionDeps } from './RemotePromptAdmission';
import { admitRemotePrompt } from './RemotePromptAdmission';
import { remoteSessionAskFromText } from './remoteSessionTellCommands';
import { MAX_TELL_MESSAGE_CHARS } from '../tools/tellLiveSessionTool';
import { ephemeralRejection } from './RemoteEphemeralMessages';
import { answerRemoteSessionQuestion, sessionQuestionForReply } from './RemoteSessionBridge';
import { agentDisplayName } from '../agentLinks/chatAgentLinks';
import { getLogger } from '../util/logger';

const log = getLogger();

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
    return answerSessionQuestion(event, match[1]!, match[2]!, deps, acknowledge, onError);
  }
  const ask = remoteSessionAskFromText(event.text);
  if (!ask) {
    if (/^\/tell(?:\s|$)/u.test(event.text))
      return ephemeralRejection('usage: /tell <claude|codex|copilot> <message>');
    return undefined;
  }
  if (!ask.message)
    return ephemeralRejection(
      ask.tell
        ? 'usage: /tell <claude|codex|copilot> <message>'
        : `usage: /${ask.target} <message>`,
    );
  if (ask.message.length > MAX_TELL_MESSAGE_CHARS) {
    return ephemeralRejection(
      ask.tell
        ? `/tell message is ${ask.message.length} chars; the limit is ${MAX_TELL_MESSAGE_CHARS}.`
        : `/${ask.target} message exceeds ${MAX_TELL_MESSAGE_CHARS} characters`,
    );
  }
  if (event.attachments?.length) return ephemeralRejection('session commands accept text only');
  const binding = deps.store.binding(event.channel, event.chatId);
  if (!binding) return ephemeralRejection('no conversation is bound');
  const result = await admitRemotePrompt(event, ask.message, key, deps, ask.target);
  if (result.kind === 'accepted' || result.kind === 'queued') {
    const title =
      deps.host.getAgentLink(binding.conversationId, ask.target)?.title ??
      `Forge · ${deps.host.status().conversations.find((item) => item.id === binding.conversationId)?.title ?? binding.conversationId}`;
    const firstLines = ask.message.split(/\r?\n/u).slice(0, 3).join('\n');
    try {
      await acknowledge(
        event.chatId,
        `→ ${agentDisplayName(ask.target)} (${title}): ${firstLines}`,
      );
    } catch (error) {
      const message = `Forge session ask notice failed: ${String(error)}`;
      try {
        if (onError) onError(message);
        else log.warn(message);
      } catch (reportError) {
        log.error(`${message}; error reporter failed: ${String(reportError)}`);
      }
    }
  }
  return result;
}

/**
 * A plain reply to the message a session question arrived as answers that
 * question. Undefined for anything else, so the reply is handled as usual.
 */
export async function admitRemoteSessionReply(
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  deps: RemotePromptAdmissionDeps,
  acknowledge: (chatId: string, text: string) => Promise<void>,
): Promise<RemoteInboundDisposition | undefined> {
  if (!event.replyToMessageId || event.text.startsWith('/')) return undefined;
  const questionId = sessionQuestionForReply(
    deps.store,
    event.channel,
    event.chatId,
    event.replyToMessageId,
  );
  if (!questionId) return undefined;
  if (event.attachments?.length || !event.text.trim()) {
    return ephemeralRejection('a session answer is text only; reply with the answer typed out');
  }
  return answerSessionQuestion(event, questionId, event.text, deps, acknowledge, deps.onError);
}

async function answerSessionQuestion(
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  questionId: string,
  answer: string,
  deps: RemotePromptAdmissionDeps,
  acknowledge: (chatId: string, text: string) => Promise<void>,
  onError?: (message: string) => void,
): Promise<RemoteInboundDisposition> {
  if (answer.trim().length > MAX_TELL_MESSAGE_CHARS) {
    return ephemeralRejection(`answer exceeds ${MAX_TELL_MESSAGE_CHARS} characters`);
  }
  const outcome = await answerRemoteSessionQuestion(
    deps.store,
    event.channel,
    event.chatId,
    questionId,
    answer,
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
