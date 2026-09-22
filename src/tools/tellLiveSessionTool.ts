import type { RegisteredTool } from './ToolRegistry';
import type { ForgeConfig } from '../config/types';
import { getMeshOrchestrator } from '../agentMesh/meshContext';

/**
 * `tell_live_session` (AGENT_MESH_PLAN §1): a **one-way** push to a live
 * Claude Code or Codex session. A distinct typed primitive, **not**
 * `ask_live_session` with `wait: false` — a notification has no expected
 * answer, no correlation id, no reply contract, no orphan policy. An `ask` has
 * all of those; overloading one call for both makes it too easy for models to
 * infer that a non-blocking send was processed.
 *
 * It delivers and **returns at once** (no `waitForReply`). Use it for
 * "started", "blocked", "turn finished", "you can stop". Coalescing rule (§3):
 * progress is host-visible and coalesced — these are events; repeated
 * percentage updates do not wake a supervisor.
 *
 * Transport cost ≠ model cost: `tell` returning saves the *sender's* model
 * turn; a notification that wakes the recipient still costs the recipient a
 * turn.
 */

const MAX_MESSAGE_CHARS = 4000;

export interface TellLiveSessionDeps {
  getConfig: () => ForgeConfig;
}

export function makeTellLiveSessionTool(deps: TellLiveSessionDeps): RegisteredTool {
  const enabled = (): boolean => deps.getConfig().agent_bus?.enabled === true;

  return {
    definition: {
      type: 'function',
      function: {
        name: 'tell_live_session',
        description:
          'Send a one-way notification (NOT a question) to a live Claude Code or Codex ' +
          'session, and return at once without waiting for an answer. Use it for progress ' +
          'and lifecycle notes: "started", "blocked", "turn finished", "you can stop". It ' +
          'does NOT block, does NOT expect a reply, and does NOT wait — so it is the right ' +
          'tool for a note, and the wrong tool for anything you need answered (use ' +
          'ask_live_session for that). Progress updates are coalesced: send state changes, ' +
          'not repeated percentages. Returns the delivery state (queued/started) so you ' +
          'know it was accepted, never that it was processed.',
        parameters: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              enum: ['claude', 'codex'],
              description: 'Which live session to notify: "claude" (default) or "codex".',
            },
            message: {
              type: 'string',
              maxLength: MAX_MESSAGE_CHARS,
              description:
                'The note. One or a few lines of state, not a question. It is shown in ' +
                'that session and recorded on the agent board.',
            },
            to: {
              type: 'string',
              maxLength: 60,
              description:
                'Optional explicit recipient alias (overrides target). Only for ' +
                'Forge-originated sends; a relay of a relay is refused.',
            },
          },
          required: ['message'],
          additionalProperties: false,
        },
      },
    },
    permission: 'delegate',
    advertise: () => enabled() && getMeshOrchestrator() !== undefined,
    handler: async (args) => {
      if (!enabled()) {
        throw new Error(
          'tell_live_session is disabled. Set `agent_bus: { enabled: true }` in config.yaml.',
        );
      }
      const orchestrator = getMeshOrchestrator();
      if (!orchestrator) {
        throw new Error('tell_live_session: the agent mesh is not up in this window.');
      }
      const message = args['message'];
      if (typeof message !== 'string' || message.trim() === '') {
        throw new Error('tell_live_session: "message" is required.');
      }
      if (message.length > MAX_MESSAGE_CHARS) {
        throw new Error(
          `tell_live_session: "message" is ${message.length} chars; the limit is ${MAX_MESSAGE_CHARS}.`,
        );
      }
      const toArg = args['to'];
      if (toArg !== undefined && (typeof toArg !== 'string' || toArg.trim() === '')) {
        throw new Error('tell_live_session: "to" must be a non-empty alias.');
      }
      const target: unknown = args['target'] ?? 'claude';
      if (target !== 'claude' && target !== 'codex') {
        throw new Error('tell_live_session: "target" must be "claude" or "codex".');
      }
      const alias = (typeof toArg === 'string' && toArg.trim() ? toArg : target)
        .trim()
        .toLowerCase();

      const outcome = await orchestrator.tell(alias, message.trim());
      if ('error' in outcome) {
        return `tell_live_session: ${outcome.error}`;
      }
      const state = outcome.observing ? 'started (owned session)' : 'accepted (queued)';
      const note = (await orchestrator.resolveAdapter(alias))?.note;
      return (
        (note
          ? `${note}

`
          : '') +
        `Notified ${outcome.to}: ${message.trim()}\n` +
        `Delivery: ${state} (exchange ${outcome.exchangeId}). ` +
        'This is a notification, not a question — it was accepted, not answered. ' +
        'Do not wait for a reply.'
      );
    },
  };
}
