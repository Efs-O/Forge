import type { RegisteredTool } from './ToolRegistry';
import type { ForgeConfig } from '../config/types';
import {
  STALE_MS,
  busPaths,
  clearExchange,
  ensureBus,
  listenerState,
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
import { armPrompt } from '../agentBus/busContent';
import { codexMessage, queueToCodex } from '../agentBus/codexDelivery';

export const MAX_SUBJECT_CHARS = 120;
export const MAX_QUESTION_CHARS = 4000;
export const MAX_WAIT_MINUTES = 20;
const ORPHANS_PER_CALL = 3;

export interface LiveSessionDeps {
  getConfig: () => ForgeConfig;
  /** Injected by tests; production uses the OS profile. */
  paths?: () => BusPaths;
  /** Injected by tests; production runs `codex queue`. */
  queueCodex?: typeof queueToCodex;
}

type Target = 'claude' | 'codex';
const LABEL: Record<Target, string> = { claude: 'Claude', codex: 'Codex' };

const NO_CODEX_THREAD =
  'No Codex session is configured, so the question was NOT sent. Tell the user. To use one, ' +
  'the user opens it in a terminal with `codex resume <thread> --sandbox workspace-write ' +
  '--add-dir "<the agent-bus folder>"` and sets `agent_bus.codex_thread: <thread>` in ' +
  'config.yaml. Do not fall back to ask_local_agent on your own.';

function orphanSection(orphans: Orphans): string {
  if (orphans.shown.length === 0) return '';
  const blocks = orphans.shown.map(
    (o) => `**Late answer** to an earlier question (\`${o.id}\`):\n\n${o.text.trim()}`,
  );
  const more = orphans.more > 0 ? `\n\n(+${orphans.more} more late answers.)` : '';
  return `${blocks.join('\n\n---\n\n')}${more}\n\n---\n\n`;
}

function notListening(paths: BusPaths): string {
  return (
    'No live Claude Code session is watching the agent bus, so the question was NOT sent. ' +
    'Tell the user. Do not fall back to ask_local_agent on your own: it starts a new, ' +
    'empty session that does not know this work.\n\n' +
    'To start a listener, the user pastes this into an open Claude Code session ' +
    '(or runs the command "Forge: Copy Claude Bus Prompt"):\n\n' +
    '```\n' +
    armPrompt(paths.root) +
    '\n```'
  );
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

/**
 * `ask_live_session`: ask the Claude Code session that is already running and
 * already knows the work, through the agent-bus files
 * (docs/plans/AGENT_BUS_TOOL_PLAN.md).
 *
 * A tool rather than a FORGE.md paragraph, because the paragraph lost: the
 * agent reached for `ask_local_agent`, which sits in its tool list on every
 * turn, and handed finished work to a brand-new session. The routing rule now
 * lives in this description, where the model reads it when it chooses.
 */
export function makeLiveSessionTool(deps: LiveSessionDeps): RegisteredTool {
  const enabled = (): boolean => deps.getConfig().agent_bus?.enabled === true;
  return {
    definition: {
      type: 'function',
      function: {
        name: 'ask_live_session',
        description:
          'Ask the Claude Code (or Codex) session that is ALREADY RUNNING on this machine, and ' +
          'already knows the current work, a question, and wait for its answer. Use this, NOT ' +
          'ask_local_agent, whenever the user means "the live session", "the other Claude", ' +
          '"the open Codex", or the session that owns the other half of a task: ' +
          'ask_local_agent always starts a ' +
          'NEW, empty session that knows nothing. Returns the exchange formatted for the ' +
          'user, so you do not need to quote it. If nobody is listening, it returns at once ' +
          'without sending, with a prompt the user can paste to start a listener. One ' +
          'question per call; blocks until the answer, the wait limit, or /stop.',
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
                'Which live session: "claude" (default) or "codex" (the open Codex session set in config).',
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
      const requested = args['wait_minutes'] ?? MAX_WAIT_MINUTES;
      if (
        typeof requested !== 'number' ||
        !Number.isInteger(requested) ||
        requested < 1 ||
        requested > MAX_WAIT_MINUTES
      ) {
        throw new Error(`ask_live_session: "wait_minutes" must be 1 to ${MAX_WAIT_MINUTES}.`);
      }

      const target = args['target'] ?? 'claude';
      if (target !== 'claude' && target !== 'codex') {
        throw new Error('ask_live_session: "target" must be "claude" or "codex".');
      }

      const paths = deps.paths ? deps.paths() : busPaths();
      ensureBus(paths);
      sweepStale(paths);
      const late = orphanSection(takeOrphans(paths, ORPHANS_PER_CALL));

      const bus = deps.getConfig().agent_bus;
      const thread = bus?.codex_thread;
      if (target === 'codex' && !thread) return late + NO_CODEX_THREAD;
      // Codex has no watcher, so there is no heartbeat to check.
      const listener = target === 'claude' ? listenerState(paths) : undefined;
      if (listener?.state === 'absent') return late + notListening(paths);

      let waitMs = requested * 60_000;
      let note = '';
      if (listener?.state === 'stale') {
        waitMs = Math.min(waitMs, STALE_MS);
        const seconds = Math.round((listener.ageMs ?? 0) / 1000);
        note = `_(The listener's heartbeat was ${seconds}s old, so it may have been re-arming; waited at most ${STALE_MS / 60_000} min.)_\n\n`;
      }

      const id = newBusId();
      const signal = context?.abortSignal;
      writeQuestion(paths, id, subject, question, target === 'codex');
      if (target === 'codex' && thread) {
        const message = codexMessage(replyFile(paths, id), id, subject, question);
        try {
          await (deps.queueCodex ?? queueToCodex)(
            bus?.codex_cli ?? 'codex',
            thread,
            message,
            signal,
          );
        } catch (err) {
          withdrawQuestion(paths, id);
          const reason = err instanceof Error ? err.message : String(err);
          return `${late}Could not deliver to Codex, so the question was NOT sent: ${reason}\n\nTell the user.`;
        }
      }
      const reply = await waitForReply(paths, id, waitMs, signal);

      if (reply !== undefined) {
        clearExchange(paths, id);
        const who = LABEL[target];
        return `${late}${note}**Asked ${who}:** ${subject}\n\n**${who} says:**\n\n${reply.trim()}`;
      }
      // Withdraw so a later answer is an orphan: announced once on the next
      // call rather than silently lost (agreed in the live test).
      withdrawQuestion(paths, id);
      if (signal?.aborted) {
        return `${late}Stopped before the live session answered. The turn is stopping; do not start further work.`;
      }
      const hint =
        target === 'codex'
          ? ' Codex answers only while its session is open in a terminal with write access to the bus folder.'
          : '';
      return (
        `${late}${note}No answer from the live ${LABEL[target]} session within ${Math.round(waitMs / 60_000)} min ` +
        `(question \`${id}\`: ${subject}). If it answers later, the answer appears at the start of ` +
        'your next ask_live_session call. Tell the user; do not fall back to ask_local_agent on ' +
        `your own.${hint}`
      );
    },
  };
}
