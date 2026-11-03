import { describe, expect, it } from 'vitest';
import { pinForgeInstructions } from '../../src/sidebar/forgeInstructionsPin';
import { freezeTurnContext, injectTurnContext } from '../../src/sidebar/turnContext';
import { prepareModelTurnMessages } from '../../src/sidebar/prepareModelTurnMessages';
import { createContextTrimState } from '../../src/agent/toolResultContext';
import {
  runtimeToPersisted,
  sidebarSessionPersistedSchema,
  type ConversationRuntime,
} from '../../src/sidebar/sessionTypes';
import { persistedToRuntime } from '../../src/sidebar/sessionPersistence';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';
import type { ChatMessage } from '../../src/llm/types';
import type { TemplateEngine } from '../../src/llm/TemplateEngine';
import type { ForgeInstructionsLoader } from '../../src/llm/ForgeInstructionsLoader';

type Conv = Pick<ConversationRuntime, 'messages' | 'compaction' | 'forgeInstructionsPin'>;

function conv(messages: ChatMessage[] = []): Conv {
  return { messages };
}

/** One turn as ModelTurn runs it: user message, pin, freeze, assistant reply. */
function turn(c: Conv, current: string | undefined, text = 'next') {
  c.messages.push({ role: 'user', content: text });
  const pinned = pinForgeInstructions(c, current);
  freezeTurnContext(c.messages, pinned.note ? { forgeInstructionsNote: pinned.note } : {});
  c.messages.push({ role: 'assistant', content: 'done' });
  return pinned;
}

describe('pinForgeInstructions', () => {
  it('pins the first text and keeps the system prompt on it after FORGE.md changes', () => {
    const c = conv();
    expect(turn(c, 'v1')).toEqual({ system: 'v1' });
    const second = turn(c, 'v2');
    expect(second.system).toBe('v1');
    expect(second.note).toContain('v2');
    expect(c.messages[2]?.turnContext).toContain('v2');
  });

  it('announces a change once, not on every later turn', () => {
    const c = conv();
    turn(c, 'v1');
    expect(turn(c, 'v2').note).toBeDefined();
    expect(turn(c, 'v2')).toEqual({ system: 'v1' });
    expect(turn(c, 'v3').note).toContain('v3');
  });

  it('says so in a short note when FORGE.md goes back to the pinned text', () => {
    const c = conv();
    turn(c, 'v1');
    turn(c, 'v2 with a long body');
    const back = turn(c, 'v1');
    expect(back.system).toBe('v1');
    expect(back.note).not.toContain('v2 with a long body');
    expect(back.note).toContain('no longer applies');
    expect(turn(c, 'v1')).toEqual({ system: 'v1' });
  });

  it('tells the model when FORGE.md is gone, and pins nothing for a chat that never had one', () => {
    const c = conv();
    turn(c, 'v1');
    expect(turn(c, undefined).note).toContain('ignore the project instructions');
    expect(turn(conv(), undefined)).toEqual({ system: undefined });
  });

  it('re-pins to the current text when compaction moves the window', () => {
    const c = conv();
    turn(c, 'v1');
    turn(c, 'v2');
    c.compaction = { summary: 'summary', fromIndex: 2 } as Conv['compaction'];
    expect(turn(c, 'v2')).toEqual({ system: 'v2' });
  });

  it('announces again when the message that carried the note was removed', () => {
    const c = conv();
    turn(c, 'v1');
    turn(c, 'v2');
    c.messages.splice(2); // undo of the turn that carried the note
    expect(turn(c, 'v2').note).toContain('v2');
  });

  it('keeps the frozen note in place, so the prefix before the new turn is unchanged', () => {
    const c = conv();
    turn(c, 'v1');
    turn(c, 'v2');
    const before = injectTurnContext(c.messages, {});
    turn(c, 'v2');
    const after = injectTurnContext(c.messages, {});
    expect(after.slice(0, before.length)).toEqual(before);
  });
});

describe('pin persistence', () => {
  it('survives a save and a reload, note and all', () => {
    const live: ConversationRuntime = {
      id: 'c1',
      title: 'Pinned',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
      forgeInstructionsPin: {
        text: 'v1',
        windowStart: 0,
        announced: { text: 'v2', messageIndex: 2 },
      },
    };
    const saved = sidebarSessionPersistedSchema.parse(
      JSON.parse(
        JSON.stringify(
          runtimeToPersisted({ activeConversationId: 'c1', conversations: [live], history: [] }),
        ),
      ),
    );
    const restored = persistedToRuntime(saved.conversations[0]!);
    expect(restored.forgeInstructionsPin).toEqual(live.forgeInstructionsPin);
  });
});

describe('prepareModelTurnMessages project instructions', () => {
  it('renders the pinned text, never the live FORGE.md', () => {
    const model = { name: 'pin-test', num_ctx: 32_768, n_parallel: 1 } as ModelConfig;
    const templateEngine = {
      render: (_name: string, ctx: Record<string, unknown>) =>
        `instructions=${String(ctx['forgeInstructions'] ?? '')}`,
    } as unknown as TemplateEngine;
    const forgeLoader = {
      root: 'N:/nowhere',
      instructionsFor: () => 'LIVE',
    } as unknown as ForgeInstructionsLoader;
    const run = (forgeInstructions: string | undefined) =>
      prepareModelTurnMessages([{ role: 'user', content: 'hi' }], {
        compaction: undefined,
        contextTrimState: createContextTrimState(),
        isVisionModel: false,
        model,
        templateEngine,
        config: { models: [model] } as unknown as ForgeConfig,
        forgeLoader,
        activeFile: undefined,
        forgeInstructions,
        workspaceIsProjectRoot: true,
        turnContext: {},
        getToolDefinitions: () => [],
      }).messages[0]?.content;
    expect(run('PINNED')).toBe('instructions=PINNED');
    expect(run(undefined)).toBe('instructions=');
  });
});
