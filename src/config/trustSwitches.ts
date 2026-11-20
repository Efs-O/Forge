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
 * `test/unit/TrustSwitches.test.ts` pins this table whole, checks every key in
 * `STARTER_OFF_KEYS` really is false in every starter, and checks each
 * `- **label**: description` line appears verbatim in `AI_SETUP.md`, so the
 * guide and the data cannot drift apart.
 */

export type TrustSwitch = {
  id: string;
  question: 3 | 4 | 5;
  label: string;
  description: string;
  configKeys: readonly string[];
};

export const TRUST_SWITCHES: readonly TrustSwitch[] = [
  {
    id: 'agentBus',
    question: 3,
    label: 'Talk to Forge',
    description:
      'Your coding agents on this PC can message Forge chats and read the replies (local only, password-protected). The next two need this one.',
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
