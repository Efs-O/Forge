/**
 * The message shape of a tool round.
 *
 * Long Strata sessions produced reasoning blocks opening with "The user hasn't
 * asked anything yet — the last message is just system instructions plus a
 * context reminder" (measured over the session logs in
 * docs/plans/NO_TASK_THINKING_PLAN.md: 415 of 88,248 assistant reasoning rows,
 * 358 of them on a round whose last message was a tool result). The prompt was
 * not at fault, and that is the invariant worth holding: on a tool round the
 * last message the model reads is the tool result, and Forge's volatile Layer C
 * block folds into the turn-opening user message instead of sitting at the
 * tail. A change that moved a reminder after the tool result would make the
 * model's complaint true, and the model would then answer as though the chat
 * had just started.
 */

import { describe, expect, it } from 'vitest';
import { prepareModelTurnMessages } from '../../src/sidebar/prepareModelTurnMessages';
import { createContextTrimState } from '../../src/agent/toolResultContext';
import { injectTurnContext } from '../../src/sidebar/turnContext';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';
import type { ChatMessage, ToolDefinition } from '../../src/llm/types';
import type { ConversationPlan, PlanItem } from '../../src/sidebar/sessionTypes';

const ITEMS: PlanItem[] = [{ text: 'fix the lease release', status: 'active' }];
const PLAN: ConversationPlan = { items: ITEMS, updatedAt: 1_000 };

/** Layer C state that renders: a date, an active file, and an unfinished plan. */
const LAYER_C = {
  currentDate: '2026-11-24',
  activeFile: 'N:/repo/BackendPool.ts',
  plan: PLAN,
};

const model = {
  name: 'shape-test',
  num_ctx: 32_768,
  n_parallel: 1,
  system_prompt: 'You are Forge. Follow the repository instructions.',
  system_prompt_mode: 'replace',
} as ModelConfig;

const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'update_plan',
      description: 'Record the task plan.',
      parameters: { type: 'object', properties: { items: { type: 'array' } } },
    },
  },
];

/** Round 2 of a turn: the transcript ends on the newest tool result. */
function toolRound(): ChatMessage[] {
  return [
    { role: 'system', content: 'Forge rules. Workspace root: N:/repo' },
    { role: 'user', content: 'Fix the lease release in BackendPool.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'update_plan', arguments: '{"items":[]}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'c1',
      name: 'update_plan',
      content: 'Plan recorded: 11 items, 1 done.',
      stampedAt: 1_000,
    },
  ];
}

function prepare(messages: ChatMessage[]): ChatMessage[] {
  const state = createContextTrimState();
  return prepareModelTurnMessages(messages, {
    compaction: undefined,
    contextTrimState: state,
    isVisionModel: false,
    model,
    templateEngine: undefined,
    config: { models: [model] } as unknown as ForgeConfig,
    forgeLoader: undefined,
    activeFile: LAYER_C.activeFile,
    forgeInstructions: undefined,
    workspaceIsProjectRoot: true,
    turnContext: LAYER_C,
    getToolDefinitions: () => tools,
  }).messages;
}

describe('a tool round ends on the tool result', () => {
  it('sends the tool result last, after every model-facing transform', () => {
    const prepared = prepare(toolRound());
    const last = prepared.at(-1);
    expect(last?.role).toBe('tool');
    expect(String(last?.content)).toContain('Plan recorded: 11 items, 1 done.');
    // Nothing was appended behind it: the request is the same length as the
    // transcript it came from.
    expect(prepared).toHaveLength(toolRound().length);
  });

  it('folds the volatile Layer C block into the turn-opening user message, not the tail', () => {
    const prepared = prepare(toolRound());
    const user = prepared.find((message) => message.role === 'user');
    expect(String(user?.content)).toContain('[Forge turn context, as of this message]');
    expect(String(user?.content)).toContain("Today's date: 2026-11-24");
    expect(String(prepared.at(-1)?.content)).not.toContain('Forge turn context');
  });
});

describe('injectTurnContext on a tool round', () => {
  it('adds no message and leaves the tool result as the last one', () => {
    const transcript = toolRound();
    const out = injectTurnContext(transcript, LAYER_C);
    expect(out).toHaveLength(transcript.length);
    expect(out.at(-1)).toEqual(transcript.at(-1));
    expect(out.at(-1)?.role).toBe('tool');
    // The block landed in the earlier user turn.
    expect(String(out[1]?.content)).toContain('[Forge turn context, as of this message]');
    expect(out[1]?.content).toContain('Fix the lease release in BackendPool.');
  });

  it('never marks the tail message internal', () => {
    const out = injectTurnContext(toolRound(), LAYER_C);
    expect(out.at(-1)?.internal).toBeUndefined();
    // And the stored transcript is not mutated by the fold.
    expect(toolRound()[1]?.content).toBe('Fix the lease release in BackendPool.');
  });
});

describe('the standalone Layer C fallback', () => {
  it('goes after the system messages, never after the tool result', () => {
    // A window with no user message to fold into, ending on a tool result.
    const transcript: ChatMessage[] = [
      { role: 'system', content: 'Forge rules.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c9',
            type: 'function',
            function: { name: 'update_plan', arguments: '{"items":[]}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c9', name: 'update_plan', content: 'Plan recorded: 1 item.' },
    ];
    const out = injectTurnContext(transcript, LAYER_C);

    expect(out).toHaveLength(transcript.length + 1);
    expect(out[1]?.role).toBe('user');
    expect(out[1]?.internal).toBe(true);
    expect(String(out[1]?.content)).toContain('[Forge turn context, as of this message]');
    // The tail is still the tool result: the fallback never sits beside it.
    expect(out.at(-1)?.role).toBe('tool');
    expect(out.at(-1)?.internal).toBeUndefined();
  });
});
