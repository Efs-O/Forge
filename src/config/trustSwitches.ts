/**
 * The trust switches a fresh install asks for — the one place their labels,
 * their Step 0 question and the config keys they turn on are written down.
 *
 * Owner's decision (2026-11-20): every one of these ships OFF in the starter
 * configs (`StarterConfig.ts`, `config/starter/*.yaml`), and the setup agent
 * (AI_SETUP.md Step 0) asks for each one and turns on exactly what the user
 * picks. `control_server` is not here: it stays on, loopback-only and
 * token-protected, because the setup checks themselves use it.
 *
 * `question` is which Step 0 question the switch is offered in (3 coding
 * agents, 4 PC control, 5 file actions). `configKeys` are dotted paths inside
 * the Forge config; `crossSessionInbound` and `globalNote` are absent because
 * they are not config keys — they write `~/.claude/settings.json` and
 * `~/.claude/CLAUDE.md`.
 *
 * `wizardSwitchQuestions` and `applyTrustPicks` are the same questions for the
 * fallback wizard (`src/sidebar/FirstRunWizard.ts`, for a user with no coding
 * agent): the same wording, the same keys, minus the switches no config file
 * can hold. `test/unit/TrustSwitches.test.ts` pins this table whole, checks every key in
 * `STARTER_OFF_KEYS` really is false in every starter, and checks each
 * `- **label**: description` line appears verbatim in `AI_SETUP.md`, so the
 * guide and the data cannot drift apart.
 */
import type { ForgeConfig } from './types';

export type TrustSwitch = {
  id: string;
  question: 3 | 4 | 5;
  label: string;
  description: string;
  /** The wizard pop-up shows one line: a short form when `description` is longer than 80 characters. */
  wizardDetail?: string;
  configKeys: readonly string[];
};

export const TRUST_SWITCHES: readonly TrustSwitch[] = [
  {
    id: 'agentBus',
    question: 3,
    label: 'Talk to Forge',
    description:
      'Your coding agents on this PC can message Forge chats and read the replies (local only, password-protected). Forge adds a short section about this to AGENTS.md / CLAUDE.md in every workspace you open, never to a file your git repository commits, and removes it when you turn this off or uninstall Forge. The next two need this one.',
    wizardDetail: 'Coding agents can message Forge chats. Adds a note to AGENTS.md / CLAUDE.md.',
    configKeys: ['agent_bus.enabled'],
  },
  {
    id: 'crossSessionInbound',
    question: 3,
    label: "Run Forge's messages without asking",
    description:
      'Messages from Forge and other sessions can start work in Claude Code with no approval prompt.',
    configKeys: [],
  },
  {
    id: 'globalNote',
    question: 3,
    label: 'Global note',
    description:
      "Add Forge's note to your global CLAUDE.md / AGENTS.md so your agents can reach Forge from any folder.",
    configKeys: [],
  },
  {
    id: 'delegate',
    question: 3,
    label: 'Hand tasks over',
    description: "Forge's model can start Claude Code or Codex on a task. Uses your subscription.",
    configKeys: ['permissions.agents.delegate'],
  },
  {
    id: 'browser',
    question: 4,
    label: 'Browser',
    description:
      'Open pages in a separate Chrome/Edge window and click and type. Asks before each new website.',
    wizardDetail: 'Open pages in a separate Chrome/Edge window. Asks before each new website.',
    configKeys: ['permissions.browser.enabled'],
  },
  {
    id: 'desktop',
    question: 4,
    label: 'Desktop',
    description: 'Take screenshots and use the mouse and keyboard.',
    configKeys: ['permissions.desktop.enabled'],
  },
  {
    id: 'jobs',
    question: 4,
    label: 'Scheduled jobs',
    description: 'Run tasks on a schedule, including waking the PC.',
    configKeys: ['jobs.enabled'],
  },
  {
    id: 'jobsCliAgents',
    question: 4,
    label: 'Jobs may run Claude Code / Codex',
    description:
      'A scheduled job can start your coding agent. Picking this also turns scheduled jobs on.',
    wizardDetail: 'A scheduled job can start your coding agent. Also turns scheduled jobs on.',
    configKeys: ['jobs.enabled', 'jobs.allow_cli_agents'],
  },
  {
    id: 'fsDelete',
    question: 5,
    label: 'Delete files',
    description: 'Each delete still shows an approval card.',
    configKeys: ['permissions.fs.delete'],
  },
  {
    id: 'gitWrite',
    question: 5,
    label: 'Git commit',
    description: 'Each commit still shows an approval card.',
    configKeys: ['permissions.git.write'],
  },
];

/**
 * Every config key that must read `false` in a starter config. Derived from
 * `TRUST_SWITCHES` so a new switch is checked without editing the check, plus
 * `remote.enabled`: Telegram is a Step 0 extra (question 6), so remote ships
 * off without being a switch of its own.
 */
export const STARTER_OFF_KEYS: readonly string[] = [
  ...new Set<string>([
    ...TRUST_SWITCHES.flatMap((switch_) => switch_.configKeys),
    'remote.enabled',
  ]),
];

/** The Step 0 heading for each question, so the wizard asks in the setup
 *  agent's words instead of writing its own. */
const QUESTION_TITLES: Record<TrustSwitch['question'], string> = {
  3: 'What may Claude Code and Codex do with Forge?',
  4: 'What may Forge control on this PC?',
  5: 'Which file actions may Forge take in your workspace?',
};

/**
 * The switches the fallback wizard can turn on itself: those with config keys.
 * Q3's coding-agent switches are offered only when a coding agent was found.
 * `crossSessionInbound` and `globalNote` are missing on purpose — they write
 * `~/.claude/settings.json` and `~/.claude/CLAUDE.md`, which only the setup
 * agent does. A question left with nothing to offer is left out entirely.
 */
export function wizardSwitchQuestions(found: {
  claude: boolean;
  codex: boolean;
}): Array<{ question: TrustSwitch['question']; title: string; switches: TrustSwitch[] }> {
  const asked: TrustSwitch['question'][] = found.claude || found.codex ? [3, 4, 5] : [4, 5];
  const questions: Array<{
    question: TrustSwitch['question'];
    title: string;
    switches: TrustSwitch[];
  }> = [];
  for (const question of asked) {
    const switches = TRUST_SWITCHES.filter(
      (switch_) => switch_.question === question && switch_.configKeys.length > 0,
    );
    if (switches.length > 0)
      questions.push({ question, title: QUESTION_TITLES[question], switches });
  }
  return questions;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Copy of `node` with `keys` set `true`: every object on the path is copied,
 *  every object off it is shared with the input, and a missing intermediate
 *  becomes `{}`. The input is never touched. */
function withKeyTrue(
  node: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const [first, ...rest] = keys;
  if (first === undefined) return node;
  if (rest.length === 0) return { ...node, [first]: true };
  const child = node[first];
  return { ...node, [first]: withKeyTrue(isRecord(child) ? child : {}, rest) };
}

/**
 * Turn on every config key of the picked switches; nothing else changes. The
 * input config is not mutated: each object the result changes is a copy, so a
 * caller can still read the config it passed in. An id the table does not hold
 * is refused rather than ignored — a silently dropped pick is a switch the
 * user asked for and never got.
 */
export function applyTrustPicks(config: ForgeConfig, pickedIds: readonly string[]): ForgeConfig {
  let next = { ...config } as unknown as Record<string, unknown>;
  for (const id of pickedIds) {
    const switch_ = TRUST_SWITCHES.find((entry) => entry.id === id);
    if (!switch_) throw new Error(`unknown trust switch: ${id}`);
    for (const key of switch_.configKeys) next = withKeyTrue(next, key.split('.'));
  }
  return next as unknown as ForgeConfig;
}
