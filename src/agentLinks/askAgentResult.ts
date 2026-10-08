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

/** Render the structured ask outcome for the model-facing tool result. */
export function renderAskAgentResult(result: AskAgentResult): string {
  const label = agentDisplayName(result.agent);
  if (result.status === 'cancelled') {
    return result.live && result.mayStillBeWorking
      ? `Forge stopped waiting for ${label}; its session may still be working. The ask was not resumed elsewhere.`
      : `Stopped the ${label} ask before it returned a reply.`;
  }
  if (result.status !== 'completed')
    return `Error: ${label} could not answer: ${result.error ?? (result.finalText || 'unknown failure')}`;
  const note = result.live
    ? '\n\nEdits this live session makes after its reply are outside this ask’s checkpoint.'
    : '';
  return `${result.notice ?? ''}**Asked ${label} (${result.sessionTitle}):** ${result.subject}\n\n**${label} says:**\n\n${result.finalText.trim()}${note}`;
}
