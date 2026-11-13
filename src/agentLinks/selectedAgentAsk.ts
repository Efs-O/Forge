import { agentTargetCatalog } from './agentTargets';
import type { AskAgentContext, AskAgentRequest, AskAgentServiceOptions } from './askAgentService';
import type { AskAgentResult } from './askAgentResult';
import type { AgentLink } from './chatAgentLinks';
import type { AskAgentRunResult } from './liveSessionDelivery';

/** Explicit selections never mutate links, resume elsewhere, or write defaults. */
export async function askSelectedAgent(
  request: AskAgentRequest,
  context: AskAgentContext,
  options: AskAgentServiceOptions,
): Promise<AskAgentResult> {
  context.signal.throwIfAborted();
  const target = agentTargetCatalog.resolve(
    context.conversation.id,
    context.workspaceRoot,
    request.targetId!,
    request,
  );
  if (target.agent !== request.agent)
    throw new Error('CLI target belongs to a different agent; nothing was sent.');
  const now = Date.now();
  const linked: AgentLink = {
    kind: target.agent,
    sessionId: target.sessionId ?? 'pending-codex-session',
    cwd: target.cwd,
    title: target.title,
    origin: 'user-set',
    linkedAt: now,
    lastUsedAt: now,
  };
  const subject = request.subject?.trim() ?? 'Selected agent task';
  const source = request.origin?.kind === 'owner' ? 'Owner message via Telegram' : 'Forge ask';
  const prompt =
    `[${source} from chat "${context.conversation.title}" · ${context.conversation.id}]\n` +
    `Subject: ${subject}\n\n${request.message.trim()}\n\nReturn a concise answer for the Forge chat.`;
  const accepted = (): void => context.onAccepted?.(linked);
  let sessionId = target.sessionId;
  let run: AskAgentRunResult;
  if (target.kind === 'existing_session') {
    if (!sessionId || !(await options.runtime.isLive(target.agent, linked)))
      throw new Error('Selected session is unavailable; nothing was sent. Discover targets again.');
    context.signal.throwIfAborted();
    run = await options.runtime.sendLive(
      target.agent,
      linked,
      prompt,
      context.signal,
      'ask',
      accepted,
      ...(request.origin ? [request.origin] : []),
    );
  } else {
    if (target.agent !== 'codex' || !target.model || !target.effort)
      throw new Error('Selected task has no supported model/effort; nothing was sent.');
    run = await options.runtime.runHeadless({
      agent: target.agent,
      link: linked,
      prompt,
      startNew: true,
      model: target.model,
      effort: target.effort,
      sessionTitle: target.title,
      signal: context.signal,
      onAccepted: accepted,
      onSessionId: (id) => {
        sessionId = id;
      },
    });
    if (run.status === 'completed' && !sessionId)
      throw new Error('Selected Codex task returned no session id; its reply was not accepted.');
  }
  const selection =
    target.kind === 'new_task'
      ? `Requested Codex model ${target.model}, effort ${target.effort}; separate task session`
      : `Selected ${target.agent} session; model and effort unknown`;
  return {
    agent: target.agent,
    status: run.status,
    finalText: run.finalText,
    subject,
    sessionTitle: target.title,
    live: target.kind === 'existing_session',
    ...(run.error ? { error: run.error } : {}),
    ...(run.mayStillBeWorking ? { mayStillBeWorking: true } : {}),
    notice: `${selection}${sessionId ? ` <${sessionId}>` : ''}.\n`,
  };
}
