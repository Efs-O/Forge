/**
 * `/tell <agent> <msg>` — a one-way note
 * from Telegram into a live session's FIFO, through the same door
 * `tell_live_session` uses.
 *
 * It is deliberately a **tell**, never an ask: a notification has no expected
 * answer, no correlation id, and no reply contract. The wording of every
 * success here says "accepted", never "started" or "delivered", because
 * `tell()` returns as soon as the message is durably queued. The outcome's
 * `observing` flag describes session ownership, not proof that anything has
 * run yet, so it is not reported either — a remote user who is told "started"
 * will wait for an answer that this command never promised.
 *
 * Gating is `getMeshOrchestrator() !== undefined`, the single guard that
 * subsumes `agent_bus.enabled`: the orchestrator exists only when the bus is
 * up. The unattended-CLI gate is NOT applied here — it exists for unattended
 * turns, and a command a person typed into Telegram is attended.
 */

/** Telegram command token to the agent kind linked to the bound Forge chat. */
const SESSION_ASK_COMMANDS = {
  '/claude': 'claude',
  '/codex': 'codex',
  '/copilot': 'copilot',
} as const;

/** Exact Telegram parsing; a prefixed token such as /codexy stays an ordinary command. */
export function remoteSessionAskFromText(
  text: string,
): { target: 'claude' | 'codex' | 'copilot'; message: string; tell: boolean } | undefined {
  const [command, ...words] = text.trim().split(/\s+/u);
  if (command === '/tell') {
    const [target, ...message] = words;
    if (target !== 'claude' && target !== 'codex' && target !== 'copilot') return undefined;
    return { target, message: message.join(' ').trim(), tell: true };
  }
  if (!command || !isSessionAskCommand(command)) return undefined;
  return { target: SESSION_ASK_COMMANDS[command], message: words.join(' ').trim(), tell: false };
}

function isSessionAskCommand(command: string): command is keyof typeof SESSION_ASK_COMMANDS {
  return Object.hasOwn(SESSION_ASK_COMMANDS, command);
}
