/**
 * Guard: instruction sources must not contradict each other, and a limit they
 * state in prose must be the limit the code enforces.
 *
 * `InstructionSourceOverlap.test.ts` scores wording similarity, so it catches a
 * rule copied with light rewording. It cannot catch three things the 2026-11-23
 * audit found in the coding-chat prompt: a contradiction worded differently
 * ("follow a background command with `monitor_execution`" against the template's
 * "do not poll a job that already wakes you"), a wrong number (`message_chat`
 * "at most 12000" while the schema says 16,000), and a rule sitting in an intro
 * paragraph the claim scan skips. Those are the checks here.
 *
 * What is compared: the sources that can land in one prompt — the shipped prompt
 * template, this repository's `FORGE.md`, the two tips tables, and the starter
 * project file. `FORGE.md` is gitignored, so every check that reads it skips when
 * it is absent, the way `InstructionSourceOverlap.test.ts` does.
 *
 * Numbers are never written here: each one is read from the tool's live
 * advertised JSON schema (or the exported constant where the schema quotes it),
 * so raising a bound in code and leaving the prose alone fails CI.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import {
  SHIPPED_TIPS_RECORDING_SENTENCE,
  clearCodingTipsCache,
  loadCodingTips,
} from '../../src/llm/codingTips';
import { makeAskUserTool } from '../../src/tools/askUserTool';
import { MESSAGE_CHAT_MESSAGE_MAX_CHARS } from '../../src/tools/messageChatSchema';
import { makeShellTool } from '../../src/tools/shellTool';
import { FOREGROUND_TIMEOUT_MAX_MS } from '../../src/tools/shellToolTimeout';

const root = path.resolve(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const PROMPT = 'config/templates/builtin/execute.njk';
const STARTER = 'resources/instructions/FORGE.starter.md';
const TIPS = 'docs/CODING_TIPS.md';
const SHIPPED = 'resources/tips/CODING_TIPS.md';
const PROJECT = 'FORGE.md';

type SourceName = typeof PROMPT | typeof STARTER | typeof TIPS | typeof SHIPPED | typeof PROJECT;

/** The five files, minus `FORGE.md` on a fresh clone where it is gitignored. */
function presentSources(): SourceName[] {
  return [PROMPT, STARTER, TIPS, SHIPPED, PROJECT].filter(
    (name) => name !== PROJECT || fs.existsSync(path.join(root, PROJECT)),
  ) as SourceName[];
}

/** Every number in a clause, with the thousands separator gone: "1,000" is 1000. */
function numbersIn(text: string): number[] {
  return (text.match(/\d[\d,]*/g) ?? []).map((n) => Number(n.replace(/,/g, '')));
}

/**
 * The bounds the code actually enforces, read from the advertised schemas.
 * `ask_user` carries several bounds on one line ("1–4 questions, labels ≤80,
 * descriptions ≤500"), so a prose limit is checked against the whole set for its
 * tool rather than against one number.
 */
function liveBounds(): Record<string, number[]> {
  const shell = makeShellTool().definition.function.parameters as {
    properties: { timeout_ms: { minimum: number } };
  };
  const ask = makeAskUserTool(new UserQuestionService()).definition.function
    .parameters as unknown as {
    properties: {
      questions: {
        minItems: number;
        maxItems: number;
        items: {
          properties: {
            header: { maxLength: number };
            options: { minItems: number; maxItems: number; items: { anyOf: unknown[] } };
          };
        };
      };
    };
  };
  const optionShape = ask.properties.questions.items.properties.options.items
    .anyOf[1] as unknown as {
    properties: { label: { maxLength: number }; description: { maxLength: number } };
  };
  return {
    // The upper bound left the schema with the refusal (an over-limit value now
    // runs in the background), so it is read from the constant that decides that.
    'shell timeout_ms': [shell.properties.timeout_ms.minimum, FOREGROUND_TIMEOUT_MAX_MS],
    ask_user: [
      ask.properties.questions.minItems,
      ask.properties.questions.maxItems,
      ask.properties.questions.items.properties.header.maxLength,
      ask.properties.questions.items.properties.options.minItems,
      ask.properties.questions.items.properties.options.maxItems,
      optionShape.properties.label.maxLength,
      optionShape.properties.description.maxLength,
    ],
    'message_chat message': [MESSAGE_CHAT_MESSAGE_MAX_CHARS],
  };
}

/** A tool name and how far a prose limit statement may run after it. */
const LIMIT_LEADS: { tool: string; lead: RegExp }[] = [
  // `(?<![A-Za-z_])` so the image tool's `request_timeout_ms` is not read as the
  // shell's `timeout_ms`.
  { tool: 'shell timeout_ms', lead: /(?<![A-Za-z_])timeout_ms[^\n]{0,60}/g },
  { tool: 'ask_user', lead: /ask_user[^\n]{0,80}/g },
  { tool: 'message_chat message', lead: /message_chat[^\n]{0,80}/g },
];

describe('instruction sources state the limits the code enforces', () => {
  const bounds = liveBounds();

  it('reads real bounds out of the schemas, not a copy', () => {
    // A schema that stopped advertising the bound would give NaN here and fail
    // every check below rather than pass vacuously.
    for (const [tool, values] of Object.entries(bounds)) {
      expect(values, tool).toEqual(values.map((v) => expect.any(Number)));
      expect(values.some((v) => Number.isFinite(v) && v > 0), tool).toBe(true);
    }
  });

  it('states no number for these tools that the schema does not enforce', () => {
    const offenders: string[] = [];
    for (const name of presentSources()) {
      const text = read(name);
      for (const { tool, lead } of LIMIT_LEADS) {
        for (const match of text.matchAll(lead)) {
          for (const number of numbersIn(match[0])) {
            if (!bounds[tool].includes(number)) {
              offenders.push(`${name}: ${tool} says ${number}: ${match[0].trim().slice(0, 120)}`);
            }
          }
        }
      }
    }
    expect(offenders, 'a prose limit that disagrees with the schema is a lie the model obeys').toEqual(
      [],
    );
  });

  it('has the template state the message limit, at the schema value', () => {
    const template = read(PROMPT);
    const claim = /message_chat[^\n]{0,80}/g.exec(template);
    expect(claim, 'the shipped prompt must still carry the message_chat limit').not.toBeNull();
    expect(numbersIn(claim![0]), 'the template disagrees with MESSAGE_CHAT_MESSAGE_MAX_CHARS').toContain(
      MESSAGE_CHAT_MESSAGE_MAX_CHARS,
    );
  });
});

describe('no source tells the model to follow a background command with monitor_execution', () => {
  /**
   * The template says a background command wakes the chat on its own and that
   * polling it is the mistake. `FORGE.md` and the starter said the opposite in
   * one line each (2026-11-23 audit, item 1), and the model obeyed the project
   * file. The negations that belong ("do not poll with `monitor_execution`",
   * "use it only when this turn must see the output") are not this claim, so the
   * shapes below name the follow-on wording only.
   */
  const FOLLOW_SHAPES = [
    /follow(?:ing)? (?:it|that|them|the call|your job)\s+with\s+`?monitor_execution/i,
    /[,.]\s+then\s+`?monitor_execution`?/i,
    /`?background:\s*true`?[^\n]{0,45}`?monitor_execution/i,
  ];

  it('never says to go poll a job that already wakes the chat', () => {
    const offenders: string[] = [];
    for (const name of presentSources()) {
      const text = read(name);
      for (const shape of FOLLOW_SHAPES) {
        const hit = shape.exec(text);
        if (hit) offenders.push(`${name}: ${hit[0].slice(0, 120)}`);
      }
    }
    expect(offenders, 'one home for the background rule: the template').toEqual([]);
  });

  it('still carries the template line that owns the rule', () => {
    expect(read(PROMPT)).toContain('do not poll with `monitor_execution` a job that already wakes you');
  });
});

describe('the shipped tips intro contradicts itself only where it is true', () => {
  const RECORDS_HERE = 'record a general tip here';

  it('drops the wrong home from the copy injected in this repository', () => {
    clearCodingTipsCache();
    const block = loadCodingTips(root);
    expect(block, 'this repository injects its own shipped table').toBeDefined();
    expect(block!.text).toContain(RECORDS_HERE);
    expect(block!.text).not.toContain('never in the shipped table');
    expect(block!.text).not.toContain(SHIPPED_TIPS_RECORDING_SENTENCE);
  });

  it('keeps the intro for a user whose shipped table is the install copy', () => {
    clearCodingTipsCache();
    // No workspace root: `workspaceShippedTipsPath` answers undefined, so this is
    // the outside-repo mode even though the file is the same text.
    const block = loadCodingTips(undefined, path.join(root, SHIPPED));
    expect(block, 'the install copy must still inject').toBeDefined();
    expect(block!.text).toContain(SHIPPED_TIPS_RECORDING_SENTENCE);
    expect(block!.text).not.toContain(RECORDS_HERE);
  });

  it('pins the sentence so an edit to the intro fails CI', () => {
    expect(read(SHIPPED)).toContain(SHIPPED_TIPS_RECORDING_SENTENCE);
  });
});

describe('one operational rule keeps one injected home', () => {
  /**
   * A topic is a rule the shipped prompt owns. Where another source states it,
   * that source must appear in `allowed` with the reason it may — a reason that
   * stops being true is a second home, which is what this file is for.
   */
  interface Topic {
    topic: string;
    pattern: RegExp;
    allowed: Partial<Record<SourceName, string>>;
  }

  // The shipped prompt is the home for every rule below, so it is never an
  // offender; the map that follows names who else may say it, and why.
  const topics: Topic[] = [
    {
      topic: 'edit_file anchors',
      pattern: /shortest unique/i,
      allowed: {
        [PROMPT]: 'the shipped prompt is the home for these rules',
        [STARTER]:
          'the starter is the seed FORGE.md written when a repository has none, and its wording is owned outside this lane',
      },
    },
    {
      topic: 'bare JSON booleans and arrays',
      pattern: /bare JSON/i,
      allowed: {
        [PROMPT]: 'the shipped prompt is the home for these rules',
        [STARTER]: 'the starter is the seed FORGE.md; same wording, same owner',
      },
    },
    {
      topic: 'message_chat needs action',
      pattern: /needs `?action/i,
      allowed: { [PROMPT]: 'the shipped prompt is the home for these rules' },
    },
    {
      // The template's rule, not the repository's clause about a refusal that is
      // itself a tool fault (which the plan merges into the tool-fault bullet and
      // which also says "route around it").
      topic: 'follow a refusal and its alternative',
      pattern: /refusal is an answer|never route around it/i,
      allowed: {
        [PROMPT]: 'the shipped prompt is the home for these rules',
        [STARTER]: 'the starter is the seed FORGE.md; same wording, same owner',
      },
    },
    {
      topic: 'name leftovers',
      pattern: /name leftovers|everything you leave behind/i,
      allowed: {
        [PROMPT]: 'the shipped prompt is the home for these rules',
        [STARTER]: 'the starter is the seed FORGE.md; same wording, same owner',
      },
    },
    {
      topic: 'a question is not a build request',
      pattern: /question is not an instruction to build/i,
      allowed: {
        [PROMPT]: 'the shipped prompt is the home for these rules',
        [STARTER]: 'the starter is the seed FORGE.md; same wording, same owner',
      },
    },
    {
      topic: 'audit range and baseline',
      pattern: /range and (?:the )?baseline|baseline first/i,
      allowed: {
        [PROMPT]: 'the shipped prompt is the home for these rules',
        [STARTER]: 'the starter is the seed FORGE.md; same wording, same owner',
      },
    },
    {
      topic: 'the durable-state ledger',
      pattern: /create, delete, pause/i,
      allowed: {
        [PROMPT]: 'the shipped prompt is the home for these rules',
        [PROJECT]:
          'this repository adds the CI gate that fails a plan with no ledger section, which the template line does not carry',
        [STARTER]:
          'pinned as the general copy of the plan-ledger concern in test/fixtures/instruction-sync.json',
      },
    },
    {
      topic: 'who owns worktree cleanup',
      pattern: /owns worktree cleanup|verifies the folder is gone/i,
      allowed: { [PROMPT]: 'the shipped prompt is the home for these rules' },
    },
  ];

  // The "Other agents in this repo" block in FORGE.md is the collaboration rules
  // this repository keeps as its own source (test/fixtures/instruction-sync.json
  // lists no verbatim copy for same-repository-agent-collaboration), so it states
  // worktrees and lanes on purpose. None of the patterns above points at it; the
  // worktree topic here is the ownership rule, which only the template states.
  it.each(topics.map((t) => [t.topic, t] as const))(
    'keeps %s in the sources that may state it',
    (_topic, entry) => {
      const offenders: string[] = [];
      for (const name of presentSources()) {
        const text = read(name);
        const hit = entry.pattern.exec(text);
        if (hit && !entry.allowed[name]) {
          offenders.push(`${name} states ${entry.topic}: ${hit[0].slice(0, 80)}`);
        }
      }
      expect(offenders).toEqual([]);
    },
  );
});
