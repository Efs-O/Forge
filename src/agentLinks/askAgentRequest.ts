/**
 * The `ask_agent` request: its shape, and the rules a request must pass before
 * any session is contacted. Split out of `askAgentService.ts` (the ask lifecycle
 * and its policies), which sits at the eslint `max-lines` cap; the request
 * contract is its own concern, and the service re-exports both so every
 * consumer keeps importing one module — the same pattern `askAgentResult.ts`
 * uses beside it.
 */
import { MAX_QUESTION_CHARS, questionSizeRefusal } from '../agentBus/liveSessionLimit';
import type { AgentKind } from './chatAgentLinks';
import type { AskAgentOrigin } from './liveSessionDelivery';

/** The longest one-line subject an ask may carry: it becomes the heading the
 *  answer is filed under and, for a new session, part of its name. */
export const MAX_SUBJECT_CHARS = 160;

export interface AskAgentRequest {
  agent: AgentKind;
  message: string;
  subject?: string;
  origin?: AskAgentOrigin;
  targetId?: string;
}

export function validateRequest(value: AskAgentRequest): AskAgentRequest {
  if (!value.message.trim()) throw new Error('ask_agent: "message" is required.');
  if (value.message.length > MAX_QUESTION_CHARS)
    throw new Error(questionSizeRefusal(`"message" exceeds ${MAX_QUESTION_CHARS} characters.`));
  if (value.subject !== undefined && !value.subject.trim())
    throw new Error('ask_agent: "subject" must not be empty.');
  if (value.subject && (value.subject.length > MAX_SUBJECT_CHARS || /[\r\n]/u.test(value.subject)))
    throw new Error(
      `ask_agent: "subject" must be one line of at most ${MAX_SUBJECT_CHARS} characters.`,
    );
  return value;
}
