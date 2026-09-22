import type { RegisteredTool } from './ToolRegistry';
import type { ForgeConfig } from '../config/types';
import {
  busPaths,
  clearExchange,
  ensureBus,
  newBusId,
  replyFile,
  sweepStale,
  takeOrphans,
  waitForReply,
  withdrawQuestion,
  writeQuestion,
  type BusPaths,
  type Orphans,
} from '../agentBus/agentBus';
import { claudeQuestion } from '../agentBus/busContent';
import { codexMessage, queueToCodex } from '../agentBus/codexDelivery';
import { getBoardContext, getMeshOrchestrator } from '../agentMesh/meshContext';
import { getAlias, joinedPeer } from '../agentMesh/aliasRegistry';
import type { TurnResult } from '../agentMesh/meshAdapter';
import {
  pickClaudePeer,
  readClaudeSessions,
  sendPeerMessage,
  type ClaudeSession,
} from '../agentBus/claudePeer';
import { relayToClaude } from '../agentBus/claudeRelay';

export const MAX_SUBJECT_CHARS = 120;
export const MAX_QUESTION_CHARS = 4000;
export const MAX_WAIT_MINUTES = 20;
const MAX_SESSION_CHARS = 60;
const ORPHANS_PER_CALL = 3;

export interface LiveSessionDeps {
  getConfig: () => ForgeConfig;
  /** Folders a Claude session must be open in to be picked by default. */
  workspaceRoots: () => string[];
  /** Injected by tests; production uses the OS profile. */
  paths?: () => BusPaths;
  /** Injected by tests; production reads ~/.claude/sessions. */
  claudeSessions?: () => ClaudeSession[];
  /** Injected by tests; production uses the configured transport. */
  sendClaude?: (session: ClaudeSession, message: string, signal?: AbortSignal) => Promise<void>;
  /** Injected by tests; production runs `codex queue`. */
  queueCodex?: typeof queueToCodex;
}

const NO_CODEX_THREAD =
  'No Codex session is available through the agent mesh or configured live pin, so the question ' +
  'was NOT sent. Tell the user. To use a user-opened one, open it in a terminal with `codex ' +
  'resume <thread> --sandbox workspace-write --add-dir "<the agent-bus folder>"` and set ' +
  '`agent_bus.codex_thread: <thread>` in config.yaml. Do not fall back to ask_local_agent on ' +
  'your own.';

const NOT_SENT_SUFFIX =
  '\n\nTell the user. Do not fall back to ask_local_agent on your own: it starts a new, ' +
  'empty session that does not know this work.';

function orphanSection(orphans: Orphans): string {
  if (orphans.shown.length === 0) return '';
  const blocks = orphans.shown.map(
    (o) => `**Late answer** to an earlier question (\`${o.id}\`):\n\n${o.text.trim()}`,
  );
  const more = orphans.more > 0 ? `\n\n(+${orphans.more} more late answers.)` : '';
  return `${blocks.join('\n\n---\n\n')}${more}\n\n---\n\n`;
}

function stringArg(args: Record<string, unknown>, key: string, max: number): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`ask_live_session: "${key}" is required.`);
  }
  if (value.length > max) {
    throw new Error(`ask_live_session: "${key}" is ${value.length} chars; the limit is ${max}.`);
  }
  return value.trim();
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  return args[key] === undefined ? undefined : stringArg(args, key, max);
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** An observed turn (a Forge-owned session) formatted for the user. */
function formatTurn(
  who: string,
  subject: string,
  result: TurnResult | { error: string },
  aborted: boolean,
): string {
  if ('error' in result)
    return `Could not deliver to ${who}, so the question was NOT sent: ${result.error}${NOT_SENT_SUFFIX}`;
  if (result.status === 'cancelled') {
    return aborted
      ? `Stopped before ${who} answered. The turn is stopping; do not start further work.`
      : `${who} cancelled the answer (interrupted or withdrawn). Tell the user.`;
  }
  const text = result.finalText?.trim();
  if (result.status === 'failed')
    return `${who} could not answer: ${text || 'its session failed'}. Tell the user.`;
  if (!text) return `${who} completed without returning an answer. Tell the user.`;
  return `**Asked ${who}:** ${subject}

**${who} says:**

${text}`;
}

/**
 * `ask_live_session`: ask a Claude Code or Codex session that is already
 * running and already knows the work (docs/plans/AGENT_MESSAGING_PLAN.md).
 * Claude gets the question in its own chat through its peer pipe; Codex through
 * `codex queue`. The answer comes back through `/agent/reply` or the outbox
 * file, both of which land where {@link waitForReply} looks.
 *
 * A tool rather than a FORGE.md paragraph, because the paragraph lost: the
 * agent reached for `ask_local_agent`, which sits in its tool list on every
 * turn, and handed finished work to a brand-new session. The routing rule now
 * lives in this description, where the model reads it when it chooses.
 */
export function makeLiveSessionTool(deps: LiveSessionDeps): RegisteredTool {
  const enabled = (): boolean => deps.getConfig().agent_bus?.enabled === true;

  const sendClaude =
    deps.sendClaude ??
    ((session: ClaudeSession, message: string, signal?: AbortSignal): Promise<void> => {
      const bus = deps.getConfig().agent_bus;
      if (bus?.claude_transport === 'relay') {
        return relayToClaude(bus.claude_cli, bus.relay_model, session.name, message, signal);
      }
      return sendPeerMessage(session, 'Forge', message);
    });

  return {
    definition: {
      type: 'function',
      function: {
        name: 'ask_live_session',
        description:
          'Ask a Claude Code (or Codex) session that is ALREADY RUNNING on this machine, and ' +
          'already knows the current work, a question, and wait for its answer. Use this, NOT ' +
          'ask_local_agent, whenever the user means "the live session", "the other Claude", ' +
          '"the open Codex", or the session that owns the other half of a task, and to answer ' +
          'a message another session sent you: ask_local_agent always starts a NEW, empty ' +
          'session that knows nothing. The target is resolved by its mesh alias (claude / ' +
          'codex); a Forge-owned session is created on first use, and ' +
          'the config thread/session value is a deprecated pin (the alias wins). The question ' +
          "appears in that session's own window. " +
          'Returns the exchange formatted for the user, so you do not need to quote it. If ' +
          'the session cannot be reached, it returns at once without sending and says why. ' +
          'One question per call; blocks until the answer, the wait limit, or /stop.',
        parameters: {
          type: 'object',
          properties: {
            subject: {
              type: 'string',
              maxLength: MAX_SUBJECT_CHARS,
              description: 'One self-contained line: all the other session sees first.',
            },
            question: {
              type: 'string',
              maxLength: MAX_QUESTION_CHARS,
              description:
                'The question. Say what you need and which files you own. The other ' +
                'session can read the repo itself, so name files; do not paste them.',
            },
            target: {
              type: 'string',
              enum: ['claude', 'codex'],
              description:
                'Which live session: "claude" (default) or "codex". Resolved by alias; a ' +
                'Forge-owned session is created with one-time consent, and the config ' +
                'thread/session value is a deprecated pin (the alias wins).',
            },
            session: {
              type: 'string',
              maxLength: MAX_SESSION_CHARS,
              description:
                'Claude only: the session name, when several are open or a message came ' +
                'from one ("<name> says:"). Omit to use the configured or only open session.',
            },
            wait_minutes: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_WAIT_MINUTES,
              description: `How long to wait for the answer, 1 to ${MAX_WAIT_MINUTES} (default ${MAX_WAIT_MINUTES}). Returns as soon as it lands.`,
            },
          },
          required: ['subject', 'question'],
          additionalProperties: false,
        },
      },
    },
    permission: 'delegate',
    advertise: enabled,
    handler: async (args, context) => {
      if (!enabled()) {
        throw new Error(
          'ask_live_session is disabled. Set `agent_bus: { enabled: true }` in config.yaml.',
        );
      }
      const subject = stringArg(args, 'subject', MAX_SUBJECT_CHARS);
      if (/[\r\n]/.test(subject)) throw new Error('ask_live_session: "subject" must be one line.');
      const question = stringArg(args, 'question', MAX_QUESTION_CHARS);
      const sessionArg = optionalString(args, 'session', MAX_SESSION_CHARS);
      const requested = args['wait_minutes'] ?? MAX_WAIT_MINUTES;
      if (
        typeof requested !== 'number' ||
        !Number.isInteger(requested) ||
        requested < 1 ||
        requested > MAX_WAIT_MINUTES
      ) {
        throw new Error(`ask_live_session: "wait_minutes" must be 1 to ${MAX_WAIT_MINUTES}.`);
      }
      const target: unknown = args['target'] ?? 'claude';
      if (target !== 'claude' && target !== 'codex') {
        throw new Error('ask_live_session: "target" must be "claude" or "codex".');
      }

      const paths = deps.paths ? deps.paths() : busPaths();
      ensureBus(paths);
      sweepStale(paths);
      const late = orphanSection(takeOrphans(paths, ORPHANS_PER_CALL));
      const bus = deps.getConfig().agent_bus;
      const signal = context?.abortSignal;
      const id = newBusId();

      // A Forge-owned session observes its turn: ask through the mesh FIFO
      // (never a direct send, which collides with a queued message) and take
      // the answer from the turn itself. A user-opened session cannot be
      // observed, so it gets the question plus a `forge.sh reply` command.
      // An explicit Claude session name bypasses the alias (§10).
      const orchestrator = getMeshOrchestrator();
      const byAlias = target === 'codex' || !sessionArg || sessionArg.toLowerCase() === 'claude';
      const adapter =
        orchestrator && byAlias ? await orchestrator.resolveAdapter(target) : undefined;
      if (orchestrator && adapter?.observesTurns) {
        const who = target === 'codex' ? 'Codex' : 'Claude';
        const message = `[Forge agent bus, question ${id}] ${subject}

${question}`;
        const result = await orchestrator.ask(target, message, signal);
        return late + formatTurn(who, subject, result, signal?.aborted === true);
      }

      let deliver: () => Promise<void>;
      let who: string;
      if (target === 'codex') {
        const thread = bus?.codex_thread;
        if (!thread) return late + NO_CODEX_THREAD;
        who = 'Codex';
        const message = codexMessage(replyFile(paths, id), id, subject, question);
        deliver = () =>
          (deps.queueCodex ?? queueToCodex)(bus?.codex_cli ?? 'codex', thread, message, signal);
      } else {
        const sessions = deps.claudeSessions ? deps.claudeSessions() : readClaudeSessions();
        const board = getBoardContext();
        const picked = pickClaudePeer(
          sessions,
          {
            explicit: byAlias ? undefined : sessionArg,
            joined: board ? joinedPeer(getAlias(board.root, 'claude')) : undefined,
            pin: bus?.claude_session,
          },
          deps.workspaceRoots(),
        );
        if ('error' in picked) return late + picked.error + NOT_SENT_SUFFIX;
        const session = picked.session;
        who = `Claude (${session.name})`;
        const message = claudeQuestion(paths.script, id, subject, question);
        deliver = () => sendClaude(session, message, signal);
      }

      writeQuestion(paths, id, subject, question);
      try {
        await deliver();
      } catch (err) {
        withdrawQuestion(paths, id);
        return `${late}Could not deliver to ${who}, so the question was NOT sent: ${reason(err)}${NOT_SENT_SUFFIX}`;
      }
      const waitMs = requested * 60_000;
      const reply = await waitForReply(paths, id, waitMs, signal);

      if (reply !== undefined) {
        clearExchange(paths, id);
        return `${late}**Asked ${who}:** ${subject}\n\n**${who} says:**\n\n${reply.trim()}`;
      }
      // Withdraw so a later answer is an orphan: announced once on the next
      // call rather than silently lost.
      withdrawQuestion(paths, id);
      if (signal?.aborted) {
        return `${late}Stopped before ${who} answered. The turn is stopping; do not start further work.`;
      }
      const hint =
        target === 'codex'
          ? ' Codex answers only while its session is open in a terminal with write access to the bus folder.'
          : ' The question was delivered to its window. If that session runs with bypass permissions ' +
            'and ~/.claude/settings.json lacks `"crossSessionInbound": "accept"`, it is waiting ' +
            'there for the user to approve it.';
      return (
        `${late}No answer from ${who} within ${requested} min ` +
        `(question \`${id}\`: ${subject}). If it answers later, the answer appears at the start of ` +
        'your next ask_live_session call. Tell the user; do not fall back to ask_local_agent on ' +
        `your own.${hint}`
      );
    },
  };
}
