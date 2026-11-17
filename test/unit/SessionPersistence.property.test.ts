import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  persistedToRuntime,
  runtimeToPersisted,
} from '../../src/sidebar/sessionPersistence';
import {
  conversationPersistedSchema,
  type ConversationRuntime,
  type SidebarRuntime,
} from '../../src/sidebar/sessionTypes';

// ---------------------------------------------------------------------------
// Generators for a SidebarRuntime whose persisted form the reader must accept.
// Values stay inside the domain the writer can actually produce (the schema
// bounds, plausible enums, non-empty ids) so a failure means the writer emits
// something the reader rejects, not that the generator invented an impossible
// chat. `last_input_tokens`/`last_output_tokens` are deliberately omitted:
// `persistedToRuntime` conditionally clears them (a documented one-shot
// normalisation when a compaction cut lands at the transcript end), which would
// test that normalisation rather than the writer's fixed point.
// ---------------------------------------------------------------------------

const idPool = fc.integer({ min: 0, max: 4 }).map((n) => `c${n}`);

const textContent = fc.oneof(
  fc.string({ maxLength: 30 }),
  fc.constant(null),
  fc.array(fc.record({ type: fc.constant('text' as const), text: fc.string({ maxLength: 20 }) }), {
    minLength: 1,
    maxLength: 2,
  }),
);

const toolCall = fc.record({
  id: idPool,
  type: fc.constant('function' as const),
  function: fc.record({
    name: fc.string({ minLength: 1, maxLength: 10 }),
    arguments: fc.string({ maxLength: 20 }),
  }),
});

const userMessage = fc.record({
  role: fc.constant('user' as const),
  content: textContent,
  createdAt: fc.integer({ min: 0, max: 1e12 }),
});
const assistantText = fc.record({
  role: fc.constant('assistant' as const),
  content: textContent,
  reasoning: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
  createdAt: fc.integer({ min: 0, max: 1e12 }),
});
// An assistant turn that announces tool calls; whether results ever arrive is
// decided by the surrounding messages, so some calls are left unanswered.
const assistantTools = fc.record({
  role: fc.constant('assistant' as const),
  content: fc.constant(null),
  tool_calls: fc.array(toolCall, { minLength: 1, maxLength: 2 }),
  reasoning: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
});
const toolResult = fc.record({
  role: fc.constant('tool' as const),
  content: fc.string({ minLength: 1, maxLength: 20 }),
  tool_call_id: idPool,
  name: fc.string({ minLength: 1, maxLength: 10 }),
  toolMs: fc.option(fc.integer({ min: 0, max: 1e6 }), { nil: undefined }),
  stampedAt: fc.option(fc.integer({ min: 0, max: 1e12 }), { nil: undefined }),
});
const systemMessage = fc.record({
  role: fc.constant('system' as const),
  content: fc.string({ maxLength: 20 }),
});

const messageArb = fc.oneof(
  userMessage,
  assistantText,
  assistantTools,
  toolResult,
  systemMessage,
) as unknown as fc.Arbitrary<ConversationRuntime['messages'][number]>;

const messagesArb = fc.array(messageArb, { minLength: 0, maxLength: 6 });

const compactionArb = fc.record({
  summary: fc.string({ minLength: 1, maxLength: 50 }),
  fromIndex: fc.integer({ min: 0, max: 8 }),
  generation: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
  dividers: fc.option(
    fc.array(
      fc.record({
        generation: fc.integer({ min: 1, max: 5 }),
        fromIndex: fc.integer({ min: 0, max: 8 }),
        source: fc.option(fc.constantFrom('auto' as const, 'manual' as const), { nil: undefined }),
      }),
      { maxLength: 3 },
    ),
    { nil: undefined },
  ),
  // The first entry has its own 12k allowance; entries above the old 4,040
  // bound are exactly the shape that lost four chats on 2026-11-17.
  userMessages: fc.option(
    fc.array(
      fc.oneof(
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.integer({ min: 4041, max: 12040 }).map((n) => 'x'.repeat(n)),
      ),
      { minLength: 1, maxLength: 5 },
    ),
    { nil: undefined },
  ),
  recordedActions: fc.option(
    fc.array(
      fc.record({
        kind: fc.constantFrom('file' as const, 'command' as const),
        key: fc.string({ minLength: 1, maxLength: 50 }),
        outcome: fc.constantFrom('ok' as const, 'failed' as const, 'unknown' as const),
        line: fc.string({ minLength: 1, maxLength: 80 }),
        durableEvidence: fc.option(fc.boolean(), { nil: undefined }),
      }),
      { maxLength: 4 },
    ),
    { nil: undefined },
  ),
  repoState: fc.option(fc.string({ maxLength: 200 }), { nil: undefined }),
  memoryKeys: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 50 }), { maxLength: 5 }), {
    nil: undefined,
  }),
  omittedActions: fc.option(
    fc.record({ file: fc.integer({ min: 0, max: 10 }), command: fc.integer({ min: 0, max: 10 }) }),
    { nil: undefined },
  ),
  lastReply: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
  lastReplyFollowedByTools: fc.option(fc.boolean(), { nil: undefined }),
  resumeNote: fc.option(
    fc.record({
      generation: fc.integer({ min: 1, max: 5 }),
      usedTokens: fc.integer({ min: 0, max: 1e6 }),
      maxTokens: fc.option(fc.integer({ min: 1, max: 1e6 }), { nil: undefined }),
    }),
    { nil: undefined },
  ),
});

const planArb = fc.record({
  items: fc.array(
    fc.record({
      text: fc.string({ minLength: 1, maxLength: 50 }),
      status: fc.constantFrom('pending' as const, 'active' as const, 'done' as const),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  updatedAt: fc.integer({ min: 0, max: 1e12 }),
});

const forgePinArb = fc.record({
  text: fc.string({ maxLength: 50 }),
  windowStart: fc.integer({ min: 0, max: 1e6 }),
  announced: fc.option(
    fc.record({
      text: fc.string({ maxLength: 50 }),
      messageIndex: fc.integer({ min: 0, max: 1000 }),
    }),
    { nil: undefined },
  ),
});

const tipsPinArb = fc.record({
  text: fc.string({ maxLength: 50 }),
  windowStart: fc.integer({ min: 0, max: 1e6 }),
});

const displayDiffsArb = fc.array(
  fc.record({
    toolCallId: fc.string({ minLength: 1, maxLength: 10 }),
    filePath: fc.string({ minLength: 1, maxLength: 20 }),
    hunks: fc.oneof(
      fc.constant(null),
      fc.array(
        fc.record({
          oldStart: fc.integer({ min: 0, max: 100 }),
          newStart: fc.integer({ min: 0, max: 100 }),
          lines: fc.array(
            fc.record({
              kind: fc.constantFrom('context' as const, 'added' as const, 'removed' as const),
              text: fc.string({ maxLength: 20 }),
            }),
            { maxLength: 3 },
          ),
        }),
        { maxLength: 2 },
      ),
    ),
    isNew: fc.boolean(),
    isDeleted: fc.boolean(),
  }),
  { maxLength: 3 },
);

// A question record whose picks always index into its own spec's options.
const questionRecordArb = fc
  .record({
    toolCallId: fc.string({ minLength: 1, maxLength: 10 }),
    optionCount: fc.integer({ min: 1, max: 3 }),
    pickCount: fc.integer({ min: 0, max: 3 }),
    skipped: fc.boolean(),
  })
  .map(({ toolCallId, optionCount, pickCount, skipped }) => ({
    toolCallId,
    record: {
      specs: [
        {
          prompt: 'Which option?',
          multiSelect: false,
          options: Array.from({ length: optionCount }, (_, i) => ({ label: `o${i}` })),
        },
      ],
      answer: skipped
        ? ({ skipped: true, answers: [] } as const)
        : {
            answers: [
              { picks: Array.from({ length: Math.min(pickCount, optionCount) }, (_, i) => i) },
            ],
          },
    },
  }));

const displayNoticesArb = fc.array(
  fc.record({
    message: fc.string({ maxLength: 30 }),
    createdAt: fc.integer({ min: 0, max: 1e12 }),
    messageIndex: fc.integer({ min: 0, max: 100 }),
  }),
  { maxLength: 3 },
);

const conversationArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  title: fc.string({ maxLength: 12 }),
  createdAt: fc.integer({ min: 0, max: 1e12 }),
  updatedAt: fc.integer({ min: 0, max: 1e12 }),
  messages: messagesArb,
  title_source: fc.option(fc.constantFrom('prompt' as const, 'user' as const, 'auto' as const), {
    nil: undefined,
  }),
  origin_agent: fc.option(fc.string({ minLength: 1, maxLength: 64 }), { nil: undefined }),
  retention_activity_at: fc.option(fc.integer({ min: 0, max: 1e12 }), { nil: undefined }),
  keep_open: fc.option(fc.boolean(), { nil: undefined }),
  opened_by: fc.option(fc.string({ minLength: 1, maxLength: 16 }), { nil: undefined }),
  active_model: fc.option(fc.string({ maxLength: 16 }), { nil: undefined }),
  cli_sessions: fc.option(
    fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.string({ minLength: 1, maxLength: 8 }), {
      maxKeys: 3,
    }),
    { nil: undefined },
  ),
  compaction: fc.option(compactionArb, { nil: undefined }),
  plan: fc.option(planArb, { nil: undefined }),
  forgeInstructionsPin: fc.option(forgePinArb, { nil: undefined }),
  codingTipsPin: fc.option(tipsPinArb, { nil: undefined }),
  displayDiffs: fc.option(displayDiffsArb, { nil: undefined }),
  displayQuestionRecords: fc.option(fc.array(questionRecordArb, { maxLength: 2 }), {
    nil: undefined,
  }),
  displayNotices: fc.option(displayNoticesArb, { nil: undefined }),
  active_time_ms: fc.option(fc.integer({ min: 0, max: 1e9 }), { nil: undefined }),
  active_started_at: fc.option(fc.integer({ min: 0, max: 1e12 }), { nil: undefined }),
  input_tokens: fc.option(fc.integer({ min: 0, max: 1e9 }), { nil: undefined }),
  output_tokens: fc.option(fc.integer({ min: 0, max: 1e9 }), { nil: undefined }),
  model_request_count: fc.option(fc.integer({ min: 0, max: 1e6 }), { nil: undefined }),
  tool_call_count: fc.option(fc.integer({ min: 0, max: 1e6 }), { nil: undefined }),
  untrusted_since_ms: fc.option(fc.integer({ min: 0, max: 1e12 }), { nil: undefined }),
  approval_rules: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 50 }), { maxLength: 5 }), {
    nil: undefined,
  }),
  clanker: fc.option(fc.boolean(), { nil: undefined }),
}) as unknown as fc.Arbitrary<ConversationRuntime>;

const runtimeArb = fc
  .record({
    conversations: fc.array(conversationArb, { minLength: 1, maxLength: 4 }),
    history: fc.array(conversationArb, { maxLength: 2 }),
  })
  .chain(({ conversations, history }) =>
    fc.constantFrom(...conversations.map((c) => c.id)).map(
      (activeConversationId) =>
        ({ activeConversationId, conversations, history }) as SidebarRuntime,
    ),
  );

function oneCycle(persisted: ReturnType<typeof runtimeToPersisted>): ReturnType<
  typeof runtimeToPersisted
> {
  const runtime = {
    activeConversationId: persisted.activeConversationId,
    conversations: persisted.conversations.map(persistedToRuntime),
    history: [] as ConversationRuntime[],
  } as SidebarRuntime;
  return runtimeToPersisted(runtime, { withHistory: true });
}

describe('property: session persistence round trip', () => {
  it('what the writer produces, the reader schema accepts', () => {
    fc.assert(
      fc.property(runtimeArb, (runtime) => {
        const P0 = runtimeToPersisted(runtime, { withHistory: true });
        for (const conversation of [...P0.conversations, ...(P0.history ?? [])]) {
          const parsed = conversationPersistedSchema.safeParse(conversation);
          if (!parsed.success) {
            throw new Error(
              `conversation ${conversation.id} rejected: ${JSON.stringify(parsed.error.issues)}`,
            );
          }
        }
        return true;
      }),
    );
  });

  it('is idempotent after one load-and-save cycle', () => {
    fc.assert(
      fc.property(runtimeArb, (runtime) => {
        const P0 = runtimeToPersisted(runtime, { withHistory: true });
        const P1 = oneCycle(P0);
        const P2 = oneCycle(P1);
        expect(P2).toEqual(P1);
        return true;
      }),
    );
  });

  it('conversation ids and the active pointer survive the round trip', () => {
    fc.assert(
      fc.property(runtimeArb, (runtime) => {
        const P0 = runtimeToPersisted(runtime, { withHistory: true });
        const P1 = oneCycle(P0);
        expect(P1.conversations.map((c) => c.id)).toEqual(P0.conversations.map((c) => c.id));
        expect(P1.activeConversationId).toBe(P0.activeConversationId);
        return true;
      }),
    );
  });
});
