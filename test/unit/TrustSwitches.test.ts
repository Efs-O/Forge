/**
 * A fresh install ships every trust switch off, and AI_SETUP.md Step 0 asks for
 * each one (owner's call, 2026-11-20). Three things have to stay in step: the
 * switch table (`src/config/trustSwitches.ts`), the starter configs the wizard
 * and the copy-ready templates write, and the question text the setup agent
 * shows. Each is checked against the table here, so none of them can drift.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ForgeConfigSchema } from '../../src/config/schema';
import type { ForgeConfig } from '../../src/config/types';
import {
  makeLlamaCppStarterConfig,
  makeOllamaStarterConfig,
} from '../../src/config/StarterConfig';
import { STARTER_OFF_KEYS, TRUST_SWITCHES, applyTrustPicks, wizardSwitchQuestions } from '../../src/config/trustSwitches';

const root = path.resolve(__dirname, '..', '..');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Read `permissions.fs.delete` or `jobs.enabled` out of a parsed config. */
const readKey = (config: unknown, dotted: string): unknown =>
  dotted
    .split('.')
    .reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), config);

const STARTER_FILES = ['llama-cpp.yaml', 'ollama.yaml', 'openai-compatible.yaml'];

const llamaCppStarter = (): ForgeConfig =>
  makeLlamaCppStarterConfig(
    [
      {
        ggufPath: 'C:/models/a.gguf',
        modelName: 'a',
        suggestion: {
          family: 'unknown',
          suggestedName: 'a',
          numCtx: 16384,
          nBatch: 512,
          flashAttn: true,
          temperature: 0.7,
          topP: 0.9,
          topK: 40,
        },
      },
    ],
    'llama-server',
  );

const wizardConfigs = (): [string, ForgeConfig][] => [
  ['StarterConfig.ts llama.cpp', llamaCppStarter()],
  ['StarterConfig.ts ollama', makeOllamaStarterConfig('http://127.0.0.1:11434', ['m'])],
];

describe('trust switch table', () => {
  // Pinned whole, strings and all: the labels are what the user answers, and
  // the keys are what Step 5 writes. A silent change here is a silent change
  // to what a new user is offered.
  it('holds every switch, its question, its label and the keys it turns on', () => {
    expect(TRUST_SWITCHES).toEqual([
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
        description:
          "Forge's model can start Claude Code or Codex on a task. Uses your subscription.",
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
    ]);
  });

  it('names every switch key once in STARTER_OFF_KEYS, plus remote', () => {
    expect(STARTER_OFF_KEYS).toEqual([
      'agent_bus.enabled',
      'permissions.agents.delegate',
      'permissions.browser.enabled',
      'permissions.desktop.enabled',
      'jobs.enabled',
      'jobs.allow_cli_agents',
      'permissions.fs.delete',
      'permissions.git.write',
      'remote.enabled',
    ]);
  });
});

describe('starter configs ship every trust switch off', () => {
  const parsed: [string, ForgeConfig][] = [
    ...STARTER_FILES.map((file): [string, ForgeConfig] => [
      `config/starter/${file}`,
      ForgeConfigSchema.parse(
        parseYaml(fs.readFileSync(path.join(root, 'config/starter', file), 'utf8')),
      ),
    ]),
    ...wizardConfigs().map(
      (entry): [string, ForgeConfig] => [entry[0], ForgeConfigSchema.parse(entry[1])],
    ),
  ];

  it.each(parsed)('%s leaves every switch key false', (_name, config) => {
    for (const key of STARTER_OFF_KEYS) {
      expect(readKey(config, key), `${_name} ${key}`).toBe(false);
    }
  });

  it.each(parsed)('%s keeps the control server on', (_name, config) => {
    // Not a switch: loopback-only, token-protected, and the setup checks use it.
    expect(config.control_server?.enabled, _name).toBe(true);
  });
});

describe('AI_SETUP.md asks for every switch', () => {
  const doc = fs.readFileSync(path.join(root, 'AI_SETUP.md'), 'utf8');

  it.each([...TRUST_SWITCHES].map((switch_) => [switch_.id, switch_] as const))(
    '%s appears in its question verbatim',
    (_id, switch_) => {
      expect(doc, switch_.id).toContain(`- **${switch_.label}**: ${switch_.description}`);
    },
  );
});

describe('an existing config keeps the switches its owner turned on', () => {
  it('parses and keeps browser and agent_bus true', () => {
    const parsed = ForgeConfigSchema.parse({
      active_model: 'grok',
      llama_server: {},
      models: [{ name: 'grok', provider: 'openai', api_key_secret: 'grok' }],
      permissions: { browser: { enabled: true } },
      agent_bus: { enabled: true },
    });
    expect(parsed.permissions?.browser?.enabled).toBe(true);
    expect(parsed.agent_bus?.enabled).toBe(true);
  });
});

// The fallback wizard (`src/sidebar/FirstRunWizard.ts`) asks these questions
// itself now that every switch ships off, so its question list and its write
// are pinned here beside the table they come from.
describe('the wizard asks the switches it can write', () => {
  it('asks no coding-agent question when no coding agent was found', () => {
    expect(wizardSwitchQuestions({ claude: false, codex: false }).map((q) => q.question)).toEqual(
      [4, 5],
    );
  });

  it('with a coding agent: only the Q3 switches a config can hold, all of the rest', () => {
    const questions = wizardSwitchQuestions({ claude: true, codex: false });
    expect(questions.map((q) => q.question)).toEqual([3, 4, 5]);
    expect(questions.map((q) => q.title)).toEqual([
      'What may Claude Code and Codex do with Forge?',
      'What may Forge control on this PC?',
      'Which file actions may Forge take in your workspace?',
    ]);
    expect(questions[0].switches.map((switch_) => switch_.label)).toEqual([
      'Talk to Forge',
      'Hand tasks over',
    ]);
    expect(questions[1].switches.map((switch_) => switch_.label)).toEqual([
      'Browser',
      'Desktop',
      'Scheduled jobs',
      'Jobs may run Claude Code / Codex',
    ]);
    expect(questions[2].switches.map((switch_) => switch_.label)).toEqual([
      'Delete files',
      'Git commit',
    ]);
  });
});

describe('applyTrustPicks', () => {
  it('turns on every key of the picked switches and nothing else', () => {
    const config = llamaCppStarter();
    const before = structuredClone(config);
    const picked = applyTrustPicks(config, ['browser', 'jobsCliAgents']);
    const turnedOn = [
      'permissions.browser.enabled',
      'jobs.enabled',
      'jobs.allow_cli_agents',
    ];
    for (const key of turnedOn) expect(readKey(picked, key), key).toBe(true);
    for (const key of STARTER_OFF_KEYS) {
      if (turnedOn.includes(key)) continue;
      expect(readKey(picked, key), key).toBe(false);
    }
    // The input is untouched: a caller can still read what it passed in.
    expect(config).toEqual(before);
  });

  it('refuses an id the table does not hold, instead of dropping the pick', () => {
    expect(() => applyTrustPicks(llamaCppStarter(), ['nope'])).toThrow(
      'unknown trust switch: nope',
    );
  });
});
