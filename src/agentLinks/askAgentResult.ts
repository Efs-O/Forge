import { agentDisplayName, type AgentKind } from './chatAgentLinks';

export interface AskAgentResult {
  agent: AgentKind;
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  finalText: string;
  sessionTitle: string;
  subject: string;
  live: boolean;
  error?: string;
  mayStillBeWorking?: boolean;
  notice?: string;
}

const LIVE_SESSION_NOTE =
  '\n\nEdits this live session makes after its reply are outside this ask’s checkpoint.';

/** Render the structured ask outcome for the model-facing tool result. */
export function renderAskAgentResult(result: AskAgentResult): string {
  const label = agentDisplayName(result.agent);
  if (result.status === 'cancelled') {
    return result.live && result.mayStillBeWorking
      ? `Forge stopped waiting for ${label}; its session may still be working. The ask was not resumed elsewhere.`
      : `Stopped the ${label} ask before it returned a reply.`;
  }
  if (result.status !== 'completed')
    // The lead that got here still matters when the answer failed: it is what
    // tells the owner the ask was resumed headlessly, or that the resumed
    // session needs unlinking, instead of a bare error they cannot act on.
    return `${result.notice ? `${result.notice}\n\n` : ''}Error: ${label} could not answer: ${result.error ?? (result.finalText || 'unknown failure')}`;
  const note = result.live ? LIVE_SESSION_NOTE : '';
  return `${result.notice ?? ''}**Asked ${label} (${result.sessionTitle}):** ${result.subject}\n\n**${label} says:**\n\n${result.finalText.trim()}${note}`;
}

/** What `ask_agent` returns once the ask is running in the background. */
export function renderAskStarted(agent: AgentKind, exchangeId: string): string {
  return `Asked ${agentDisplayName(agent)} (exchange ${exchangeId}). Its reply will arrive as a message in this chat; carry on with the rest of the task.`;
}

/** A second ask to an agent that has not replied yet: nothing was sent. */
export function renderAskStillPending(agent: AgentKind, exchangeId: string, age: string): string {
  const label = agentDisplayName(agent);
  return `${label} is still working on exchange ${exchangeId} (asked ${age} ago); nothing new was sent. Its reply will arrive as a message: do not ask again. Carry on, or end your turn if you cannot continue without it.`;
}

/** The chat message that carries a background ask's outcome to the asking chat. */
export function renderAskReplyMessage(exchangeId: string, result: AskAgentResult): string {
  const label = agentDisplayName(result.agent);
  const subject = result.subject ? `: ${result.subject}` : '';
  const background = result.live
    ? ''
    : `; a new background ${label} session answered, not a session the owner has open`;
  const heading =
    result.status === 'completed'
      ? `**${label} replied** (ask_agent exchange ${exchangeId}${subject}${background})`
      : `**${label} did not reply** (ask_agent exchange ${exchangeId}${subject})`;
  const body =
    result.status === 'completed'
      ? `${result.notice ?? ''}${result.finalText.trim()}${result.live ? LIVE_SESSION_NOTE : ''}`
      : renderAskAgentResult(result);
  return `${heading}\n\n${body}`;
}
