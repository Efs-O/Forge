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
import { awaitedAnswers } from '../agentBus/awaitedAnswers';
import { liveAnswerNotices } from '../agentBus/liveAnswerNotices';
import { codexMessage, queueToCodex } from '../agentBus/codexDelivery';
import { getBoardContext, getMeshOrchestrator } from '../agentMesh/meshContext';
import { getAlias, joinedPeer } from '../agentMesh/aliasRegistry';
import { CodexQueueAdapter } from '../agentMesh/adapters';
import type { TurnResult } from '../agentMesh/meshAdapter';
import {
  pickClaudePeer,
  readClaudeSessions,
  sendPeerMessage,
  type ClaudeSession,
} from '../agentBus/claudePeer';
import { relayToClaude } from '../agentBus/claudeRelay';
import { unattendedCliRefusal } from '../jobs/cliAgentGate';
import { MAX_QUESTION_CHARS, questionSizeRefusal } from '../agentBus/liveSessionLimit';
export { MAX_QUESTION_CHARS };

export const MAX_SUBJECT_CHARS = 160;
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
  'No Codex session is available through the agent mesh or configured live pin, so the ' +
  'question was NOT sent. Tell the user. To use a user-opened one, join it ' +
  '(`forge.sh join codex`) or open it in a terminal with `codex resume <thread> ' +
  '--sandbox workspace-write --add-dir "<the agent-bus folder>"` and set ' +
  '`agent_bus.codex_thread: <thread>` in config.yaml. Do not fall back to ' +
  'ask_local_agent on your own.';

const CODEX_STAND_IN_FAILED =
  'The Codex session the user joined could not be resumed headlessly, so the ' +
  'question was NOT sent. The reason was already shown to the user. Tell the ' +
  'user. Do not fall back to ask_local_agent on your own: it starts a new, ' +
  'empty session that does not know this work.';

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
    if (key === 'question') {
      throw new Error(
        questionSizeRefusal(`the question is ${value.length} characters; the limit is ${max}.`),
      );
    }
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

function timeoutText(who: string, minutes: number, id: string, subject: string): string {
  return (
    `No answer from ${who} within ${minutes} min ` +
    `(question \`${id}\`: ${subject}). If it answers later, the answer appears at the start of ` +
    'your next ask_live_session call. Tell the user; do not fall back to ask_local_agent on ' +
    'your own.'
  );
}

/** notify_on_answer: run the wait detached and return at once (plan: LIVE_SESSION_NOTIFY_ON_ANSWER). */
function deferAnswer(
  conversationId: string,
  id: string,
  who: string,
  subject: string,
  minutes: number,
  settle: (signal: AbortSignal) => Promise<string>,
  timeout: { abortAfterMs: number; timeoutText: string } | undefined = undefined,
): string {
  liveAnswerNotices.defer({ id, conversationId, who, subject, settle, ...timeout });
  return (
    `Sent to ${who} without waiting (question \`${id}\`: ${subject}). Its answer arrives in this ` +
    `chat as a "[Forge notice]" message within ${minutes} min, starting a new turn if the chat is ` +
    'idle. Continue other work or end your turn; do not poll or ask again for this question.'
  );
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
          'Ask a Claude Code, Codex, or Copilot session ALREADY RUNNING on this machine, ' +
          'which knows the current work, and wait for its answer. Use it for "the live ' +
          'session", "the other Claude", "the open Codex", or to answer a message another ' +
          'session sent you (ask_local_agent starts a NEW, empty session instead). The ' +
          'target is resolved by alias (claude / codex / copilot). Returns the exchange ' +
          'formatted for the user; an unreachable session returns at once, saying why. One ' +
          'question per call; blocks until the answer, the wait limit, or /stop. To keep ' +
          'working instead of blocking, set notify_on_answer: the call returns at once and the ' +
          'answer arrives later in this chat as a "[Forge notice]" message (a new turn if the ' +
          'chat is idle). Not delivered if the window reloads first.',
        parameters: {
          type: 'object',
          properties: {
            subject: {
              type: 'string',
              maxLength: MAX_SUBJECT_CHARS,
              description: `One self-contained line, at most ${MAX_SUBJECT_CHARS} characters: all the other session sees first. Detail goes in "question".`,
            },
            question: {
              type: 'string',
              maxLength: MAX_QUESTION_CHARS,
              description:
                `The question, at most ${MAX_QUESTION_CHARS.toLocaleString('en-US')} characters. ` +
                'For a longer report, write it to a file and send the path plus at most 1,500 ' +
                'characters. Say what you need and which files you own; the other session can ' +
                'read the repo, so name files instead of pasting them.',
            },
            target: {
              type: 'string',
              enum: ['claude', 'codex', 'copilot'],
              description:
                'Which live session: "claude", "codex", or "copilot". Required: name the ' +
                'session this conversation is working with. Resolved ' +
                'by alias; a Forge-owned session is created with one-time consent, and the ' +
                'config thread/session value is a deprecated pin (the alias wins).',
            },
            session: {
              type: 'string',
              maxLength: MAX_SESSION_CHARS,
              description:
                'Claude only: the session name, when several are open or a message came ' +
                'from one ("<name> says:"). Omit to use the configured or only open session.',
            },
            notify_on_answer: {
              type: 'boolean',
              description:
                'Return at once and deliver the answer to this chat as a new message when it ' +
                'lands (within wait_minutes). Use it when you have other work to do meanwhile; ' +
                'do not poll or re-ask. Default false: block until the answer.',
            },
            wait_minutes: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_WAIT_MINUTES,
              description: `How long to wait for the answer, 1 to ${MAX_WAIT_MINUTES} (default ${MAX_WAIT_MINUTES}). Returns as soon as it lands.`,
            },
          },
          required: ['subject', 'question', 'target'],
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
      const requestedWaitMinutes = args['wait_minutes'] ?? MAX_WAIT_MINUTES;
      if (
        typeof requestedWaitMinutes !== 'number' ||
        !Number.isInteger(requestedWaitMinutes) ||
        requestedWaitMinutes < 1
      ) {
        throw new Error(`ask_live_session: "wait_minutes" must be 1 to ${MAX_WAIT_MINUTES}.`);
      }
      const requested = Math.min(requestedWaitMinutes, MAX_WAIT_MINUTES);
      const waitClampNote =
        requestedWaitMinutes > MAX_WAIT_MINUTES
          ? `wait_minutes clamped to ${String(MAX_WAIT_MINUTES)}. `
          : '';
      const notifyOnAnswer = args['notify_on_answer'] === true;
      if (notifyOnAnswer && !context?.conversationId) {
        throw new Error(
          'ask_live_session: notify_on_answer requires a conversation; ask from a chat.',
        );
      }
      const conversationId = context?.conversationId ?? '';
      if (notifyOnAnswer) {
        try {
          liveAnswerNotices.assertCanDefer();
        } catch (err) {
          throw new Error(`ask_live_session: ${reason(err)}`);
        }
      }
      // No default: a missing target once sent a Codex review round to Claude,
      // which answered GO in Codex's place.
      const target: unknown = args['target'];
      if (target !== 'claude' && target !== 'codex' && target !== 'copilot') {
        throw new Error(
          'ask_live_session: "target" is required: "claude", "codex", or "copilot". Use the ' +
            'session this conversation has been asking; nothing was sent.',
        );
      }

      const refusal = unattendedCliRefusal(deps.getConfig(), context?.conversationId);
      if (refusal) return `ask_live_session: ${refusal}`;
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
      const byAlias =
        target === 'codex' ||
        target === 'copilot' ||
        !sessionArg ||
        sessionArg.toLowerCase() === 'claude';
      const adapter =
        orchestrator && byAlias ? await orchestrator.resolveAdapter(target) : undefined;
      if (orchestrator && adapter?.observesTurns) {
        const who = target === 'codex' ? 'Codex' : target === 'copilot' ? 'Copilot' : 'Claude';
        // Forge reads this turn's final message as the answer. Say so: told by
        // AGENTS.md to run `forge.sh reply`, Codex reached for a bare `bash`,
        // which in PowerShell is WSL, and failed on a machine without it.
        const message = `[Forge agent bus, question ${id}] ${subject}

${question}

(Your final message in this turn is the answer; Forge reads it directly. Do not run forge.sh reply or write an outbox file.)`;
        const note = adapter.note;
        const settle = async (sig?: AbortSignal): Promise<string> => {
          const result = await orchestrator.ask(target, message, sig);
          const turn = formatTurn(who, subject, result, sig?.aborted === true);
          return note
            ? `${note}

${turn}`
            : turn;
        };
        if (notifyOnAnswer) {
          return (
            waitClampNote +
            late +
            deferAnswer(conversationId, id, who, subject, requested, settle, {
              abortAfterMs: requested * 60_000,
              timeoutText: timeoutText(who, requested, id, subject),
            })
          );
        }
        return (
          waitClampNote + late + (await awaitedAnswers.during(target, id, () => settle(signal)))
        );
      }

      let deliver: () => Promise<void>;
      let who: string;
      if (target === 'codex') {
        // The adapter was resolved earlier in this handler. While a user-opened
        // Codex window is live, that is a non-observing CodexQueueAdapter whose
        // thread is the alias's (or a live pin's) — take it from the adapter
        // rather than re-reading a pin that may not match (Phase 4).
        const queueAdapter = adapter instanceof CodexQueueAdapter ? adapter : undefined;
        const aliasRec = getAlias(paths.root, 'codex');
        if (queueAdapter) {
          who = 'Codex';
          const message = codexMessage(replyFile(paths, id), id, subject, question);
          deliver = () =>
            (deps.queueCodex ?? queueToCodex)(
              bus?.codex_cli ?? 'codex',
              queueAdapter.thread,
              message,
              signal,
            );
        } else if (aliasRec?.by === 'user' && orchestrator) {
          // A user-joined alias whose stand-in could not reach the thread
          // (create failed, mismatched id, protocol error, timeout). The
          // reason was shown to the user; refuse plainly and never queue to a
          // thread no window holds (invariant 5). Gated on the orchestrator:
          // without one, no stand-in was ever attempted, so that wording
          // would be false (audit, minor 5).
          return late + CODEX_STAND_IN_FAILED;
        } else if (bus?.codex_thread) {
          // No alias: the deprecated pin, used only when no alias exists.
          const pin = bus.codex_thread;
          who = 'Codex';
          const message = codexMessage(replyFile(paths, id), id, subject, question);
          deliver = () =>
            (deps.queueCodex ?? queueToCodex)(bus?.codex_cli ?? 'codex', pin, message, signal);
        } else {
          return late + NO_CODEX_THREAD;
        }
      } else if (target === 'copilot') {
        // Copilot is always an owned observing session; reaching here means no
        // copilot session could be resolved (CLI missing / creation failed).
        return (
          late +
          'No live Copilot session is available, so the question was NOT sent. Copilot is ' +
          'reached as a Forge-owned session under the `copilot` alias; check that the ' +
          'Copilot CLI is installed and signed in. Do not fall back to ask_local_agent on ' +
          'your own.'
        );
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
      const settle = async (sig?: AbortSignal): Promise<string> => {
        const reply = await waitForReply(paths, id, waitMs, sig);
        if (reply !== undefined) {
          clearExchange(paths, id);
          return `**Asked ${who}:** ${subject}\n\n**${who} says:**\n\n${reply.trim()}`;
        }
        // Withdraw so a later answer is an orphan: announced once on the next
        // call rather than silently lost.
        withdrawQuestion(paths, id);
        if (sig?.aborted) {
          return `Stopped before ${who} answered. The turn is stopping; do not start further work.`;
        }
        const hint =
          target === 'codex'
            ? ' Codex answers only while its session is open in a terminal with write access to the bus folder.'
            : ' The question was delivered to its window. If that session runs with bypass permissions ' +
              'and ~/.claude/settings.json lacks `"crossSessionInbound": "accept"`, it is waiting ' +
              'there for the user to approve it.';
        return `${timeoutText(who, requested, id, subject)}${hint}`;
      };
      if (notifyOnAnswer) {
        return (
          waitClampNote + late + deferAnswer(conversationId, id, who, subject, requested, settle)
        );
      }
      return waitClampNote + late + (await awaitedAnswers.during(target, id, () => settle(signal)));
    },
  };
}
