import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { busPaths } from '../agentBus/agentBus';
import type { RemoteAuth } from './RemoteAuth';
import { appendHostNotification } from './remoteOutboxDraft';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteSessionTarget } from './RemoteSessionAsk';
import type { RemoteInboundEvent } from './types';

const QUESTION_MS = 20 * 60_000;
const MAX_TEXT = 4_000;

export type RemoteSessionActionResult =
  | { kind: 'notified' }
  | { kind: 'asked'; questionId: string }
  | { kind: 'refused'; error: string };

/** Local agents name an exchange, never a chat id or bot credential. */
export async function remoteSessionAction(input: {
  from: string;
  exchangeId: string;
  action: 'notify' | 'ask';
  text: string;
  store: RemoteRequestStore;
  auth: RemoteAuth;
  available: (channel: RemoteInboundEvent['channel']) => boolean;
  kick: (channel: RemoteInboundEvent['channel']) => void;
}): Promise<RemoteSessionActionResult> {
  const { from, exchangeId, action, text, store, auth, available, kick } = input;
  if (!isTarget(from)) return { kind: 'refused', error: 'sender must be claude, codex or copilot' };
  if (!text.trim() || text.length > MAX_TEXT) {
    return { kind: 'refused', error: `text must be 1-${MAX_TEXT} characters` };
  }
  const request = store.getRequest(exchangeId);
  if (!request || request.sessionTarget !== from || !activeRequest(request)) {
    return { kind: 'refused', error: 'no active remote session exchange for this sender' };
  }
  if (!available(request.channel))
    return { kind: 'refused', error: 'remote transport is not active' };
  if (!(await auth.canDeliver(request.channel, request.chatId))) {
    return { kind: 'refused', error: 'the originating remote chat is no longer authorized' };
  }
  const questionId = action === 'ask' ? randomUUID() : undefined;
  let accepted = false;
  let refusal = 'the exchange ended before delivery';
  await store.contactMutate((draft) => {
    const current = draft.requests.find((item) => item.id === exchangeId);
    if (!current || current.sessionTarget !== from || !activeRequest(current)) return;
    if (draft.outbox.filter((item) => item.requestId === exchangeId).length >= 20) {
      refusal = 'this exchange has reached its 20-message limit';
      return;
    }
    if (
      questionId &&
      draft.sessionQuestions.some(
        (item) => item.requestId === exchangeId && !item.answerText && item.expiresAt > Date.now(),
      )
    ) {
      refusal = 'a question from this exchange is already waiting for an answer';
      return;
    }
    if (questionId) {
      draft.sessionQuestions.push({
        id: questionId,
        requestId: exchangeId,
        channel: current.channel,
        chatId: current.chatId,
        expiresAt: Date.now() + QUESTION_MS,
      });
    }
    appendHostNotification(
      draft,
      current.channel,
      current.chatId,
      questionId
        ? `${from} asks: ${text}\n\nReply: /answer ${questionId} <your answer>`
        : `${from}: ${text}`,
      false,
      exchangeId,
    );
    accepted = true;
  });
  if (!accepted) return { kind: 'refused', error: refusal };
  kick(request.channel);
  return questionId ? { kind: 'asked', questionId } : { kind: 'notified' };
}

/** An answer is scoped by the authenticated chat and the durable question id. */
export async function answerRemoteSessionQuestion(
  store: RemoteRequestStore,
  channel: RemoteInboundEvent['channel'],
  chatId: string,
  questionId: string,
  answer: string,
  busRoot = busPaths().root,
): Promise<'answered' | 'duplicate' | 'missing'> {
  if (!answer.trim() || answer.length > MAX_TEXT) return 'missing';
  const question = store.contactRead((state) =>
    state.sessionQuestions.find((item) => item.id === questionId),
  );
  if (
    !question ||
    question.channel !== channel ||
    question.chatId !== chatId ||
    question.expiresAt < Date.now()
  )
    return 'missing';
  const request = store.getRequest(question.requestId);
  if (!request || !activeRequest(request)) return 'missing';
  if (question.answerText) return 'duplicate';
  const saved = writeRemoteSessionAnswer(questionId, answer.trim(), busRoot);
  await store.contactMutate((draft) => {
    const current = draft.sessionQuestions.find((item) => item.id === questionId);
    if (current && !current.answerText) current.answerText = saved.text;
  });
  return saved.fresh ? 'answered' : 'duplicate';
}

export function remoteSessionAnswerPath(questionId: string, busRoot = busPaths().root): string {
  if (!/^[0-9a-f-]{36}$/u.test(questionId)) throw new Error('invalid remote question id');
  return path.join(busRoot, 'remote-answers', `${questionId}.md`);
}

function writeRemoteSessionAnswer(
  questionId: string,
  answer: string,
  busRoot: string,
): { fresh: boolean; text: string } {
  const file = remoteSessionAnswerPath(questionId, busRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) return { fresh: false, text: fs.readFileSync(file, 'utf8') };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, answer, 'utf8');
    fs.renameSync(tmp, file);
    return { fresh: true, text: answer };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // The answer was already atomically published; cleanup cannot undo it.
        console.error('Forge could not remove a remote answer temp file', err); // eslint-disable-line no-console -- cleanup after durable publication
      }
    }
  }
}

function isTarget(value: string): value is RemoteSessionTarget {
  return value === 'claude' || value === 'codex' || value === 'copilot';
}

function activeRequest(request: { state: string; updatedAt: number }): boolean {
  return (
    request.state === 'running' ||
    (request.state === 'unknown' && Date.now() - request.updatedAt < QUESTION_MS)
  );
}
