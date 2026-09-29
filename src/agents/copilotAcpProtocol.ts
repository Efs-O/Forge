/**
 * The Copilot ACP protocol rules, split out of `CopilotAcpSession` so the
 * session class stays focused on transport and turn ownership.
 *
 * ACP v1 wire shape (newline-delimited JSON-RPC) is fixed by
 * docs/reports/COPILOT_CLI_TRANSPORT_SPIKE.md. Only `session/update`
 * `agent_message_chunk` text belongs in the final answer; the prompt
 * response's `stopReason` is the terminal truth.
 */

/** A turn surface that update routing can write into. */
export interface CopilotTurnUpdateSink {
  /** Accumulated answer text (agent_message_chunk only). */
  text: string;
  onEvent?: (event: { kind: 'text' | 'status'; text: string }) => void;
}

/**
 * Validates the `initialize` result: protocolVersion must be exactly 1 and
 * the agent must advertise `loadSession` (resume is a P1 requirement).
 */
export function validateCopilotInitResult(result: unknown): void {
  const value =
    result && typeof result === 'object' ? (result as Record<string, unknown>) : undefined;
  const version = value?.['protocolVersion'];
  if (version !== 1) {
    throw new Error(
      `Copilot ACP initialize returned an unsupported protocolVersion ${String(version)}.`,
    );
  }
  const capabilities =
    value?.['agentCapabilities'] && typeof value['agentCapabilities'] === 'object'
      ? (value['agentCapabilities'] as Record<string, unknown>)
      : undefined;
  if (capabilities?.['loadSession'] !== true) {
    throw new Error('Copilot ACP agent does not support session/load.');
  }
}

/**
 * Validates a `session/new` / `session/load` result. `session/new` must
 * return a non-empty session id. Per the ACP spec, `session/load` responds
 * with an empty result `{}` after replaying the conversation — the confirmed
 * id is the one requested, and a different id in the result is a protocol
 * violation. Returns the confirmed id.
 */
export function validateCopilotSessionResult(
  result: unknown,
  method: string,
  expectedId?: string,
): string {
  const value =
    result && typeof result === 'object' ? (result as Record<string, unknown>) : undefined;
  const id = value?.['sessionId'];
  if (method === 'session/load') {
    if (typeof id === 'string' && id.trim() !== '' && expectedId && id !== expectedId) {
      throw new Error('Copilot session/load returned a mismatched session id.');
    }
    if (!expectedId) throw new Error('Copilot session/load was called without a session id.');
    return expectedId;
  }
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(`Copilot ${method} returned no session id.`);
  }
  return id;
}

/** The `stopReason` from a `session/prompt` result, when it is a string. */
export function copilotPromptStopReason(result: unknown): string | undefined {
  const value =
    result && typeof result === 'object' ? (result as Record<string, unknown>) : undefined;
  const stopReason = value?.['stopReason'];
  return typeof stopReason === 'string' ? stopReason : undefined;
}

/**
 * Routes one `session/update` notification into the active turn.
 * `agent_message_chunk` text is the answer; every other variant is a concise
 * status event. Calls `onProtocolError` (and returns) on a violation.
 */
export function applyCopilotSessionUpdate(
  params: unknown,
  active: CopilotTurnUpdateSink,
  sessionId: string | undefined,
  onProtocolError: (message: string) => void,
): void {
  const record =
    params && typeof params === 'object' ? (params as Record<string, unknown>) : undefined;
  if (!record) {
    onProtocolError('Copilot session/update had no params.');
    return;
  }
  const updateSessionId = record['sessionId'];
  if (typeof updateSessionId !== 'string' || (sessionId && updateSessionId !== sessionId)) {
    onProtocolError('Copilot session/update did not match the active session.');
    return;
  }
  const update =
    record['update'] && typeof record['update'] === 'object'
      ? (record['update'] as Record<string, unknown>)
      : undefined;
  if (!update) return;
  const kind = update['sessionUpdate'];
  if (kind === 'agent_message_chunk') {
    const content =
      update['content'] && typeof update['content'] === 'object'
        ? (update['content'] as Record<string, unknown>)
        : undefined;
    if (content?.['type'] !== 'text' || typeof content['text'] !== 'string') {
      onProtocolError('Copilot agent_message_chunk had no text content.');
      return;
    }
    active.text += content['text'];
    active.onEvent?.({ kind: 'text', text: content['text'] });
    return;
  }
  // Every other update variant (thoughts, tool calls, plan, info) is status
  // only — never part of the final answer.
  active.onEvent?.({ kind: 'status', text: `[copilot: ${String(kind ?? 'update')}]` });
}
