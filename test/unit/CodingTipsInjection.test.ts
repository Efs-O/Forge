/**
 * Phase 4 of INSTRUCTION_AND_TOOL_TEXT_STREAMLINE_PLAN.md: the tips table reaches
 * the model by code, on its own budget.
 *
 * The failure modes this pins:
 *  - the shipped table must actually be in the package (the markdown glob in
 *    `.vscodeignore` can silently drop it, which is how shipped skills once vanished);
 *  - a long PROJECT table must lose only its own tail, never the shipped table;
 *  - the project file duplicating the shipped one must not cost the prompt twice;
 *  - the block must not depend on the instruction chain's budget, so a repository
 *    that fills FORGE.md to the chain cap still gets its tips;
 *  - the rendered block must be stable between rounds of one conversation, because
 *    it sits at the prompt head and a changed byte costs a cold prefill.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearCodingTipsCache,
  CODING_TIPS_TAG,
  loadCodingTips,
  PROJECT_TIPS_ALLOWANCE,
  resolveShippedTipsPath,
  SHIPPED_TIPS_ALLOWANCE,
} from '../../src/llm/codingTips';
import { pinCodingTips } from '../../src/sidebar/codingTipsPin';
import { persistedToRuntime, runtimeToPersisted } from '../../src/sidebar/sessionPersistence';
import { openConversationSignature } from '../../src/sidebar/openConversationsPersistence';
import { TIPS_PIN_TEXT_MAX_CHARS } from '../../src/llm/codingTipsBudget';
import {
  conversationPersistedBaseSchema,
  sidebarSessionPersistedSchema,
  type ConversationRuntime,
} from '../../src/sidebar/sessionTypes';
import { buildTemplateContext } from '../../src/sidebar/turnModelBehavior';
import { prepareModelTurnMessages } from '../../src/sidebar/prepareModelTurnMessages';
import { createContextTrimState } from '../../src/agent/toolResultContext';
import type { TemplateEngine } from '../../src/llm/TemplateEngine';
import type { ForgeInstructionsLoader } from '../../src/llm/ForgeInstructionsLoader';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';

const repoRoot = path.resolve(__dirname, '..', '..');

function makeWorkspace(tips: string | undefined): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-tips-'));
  if (tips !== undefined) {
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'CODING_TIPS.md'), tips, 'utf8');
  }
  return dir;
}

const TABLE = '## READ\n1. a guessed end_line → refused: start_line past end_line. read whole\n';

let workspace = '';

beforeEach(() => clearCodingTipsCache());
afterEach(() => {
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  workspace = '';
  clearCodingTipsCache();
});

describe('the shipped tips table', () => {
  it('is in the repository so the packager can ship it', () => {
    const shipped = resolveShippedTipsPath();
    expect(shipped, 'resources/tips/CODING_TIPS.md must exist').toBeTruthy();
    const text = fs.readFileSync(shipped as string, 'utf8');
    expect(text).toContain('\n## ');
    expect(
      Buffer.byteLength(text, 'utf8'),
      'the shipped table must fit its own allowance',
    ).toBeLessThanOrEqual(SHIPPED_TIPS_ALLOWANCE);
  });

  it('is named by .vscodeignore, because a root **/*.md strip would drop it', () => {
    const ignore = fs.readFileSync(path.join(repoRoot, '.vscodeignore'), 'utf8');
    expect(ignore).toContain('!resources/tips/CODING_TIPS.md');
  });
});

describe('loadCodingTips', () => {
  it('injects the shipped table alone when the project has none', () => {
    workspace = makeWorkspace(undefined);
    const block = loadCodingTips(workspace);
    expect(block).toBeDefined();
    expect(block?.sources.map((s) => s.kind)).toEqual(['shipped']);
    expect(block?.text).toContain('## READ');
  });

  it('clamps only the project table when it is too long, and says which file', () => {
    workspace = makeWorkspace(`${TABLE}${'x'.repeat(PROJECT_TIPS_ALLOWANCE + 500)}`);
    const block = loadCodingTips(workspace);
    const project = block?.sources.find((s) => s.kind === 'project');
    const shipped = block?.sources.find((s) => s.kind === 'shipped');
    expect(project?.truncated, 'a project table over its allowance must be clamped').toBe(true);
    expect(
      Buffer.byteLength(project?.text ?? ''),
      'a clamped project table must fit its allowance',
    ).toBeLessThanOrEqual(PROJECT_TIPS_ALLOWANCE);
    expect(project?.text).toContain('docs/CODING_TIPS.md');
    expect(shipped?.truncated, 'the shipped table must survive a long project table').toBe(false);
    expect(block?.text).toContain('read-only');
  });

  it('injects the table once when the project file is the shipped file', () => {
    const shipped = resolveShippedTipsPath() as string;
    workspace = makeWorkspace(fs.readFileSync(shipped, 'utf8'));
    const block = loadCodingTips(workspace);
    expect(block?.duplicateSkipped).toBe(true);
    expect(block?.sources.map((s) => s.kind)).toEqual(['shipped']);
    expect(block?.text).toContain('injected once');
  });

  it('injects the project table alone when the shipped file is missing', () => {
    workspace = makeWorkspace(TABLE);
    const block = loadCodingTips(workspace, path.join(workspace, 'no-shipped-here.md'));
    expect(block?.sources.map((s) => s.kind)).toEqual(['project']);
    expect(block?.text).toContain('a guessed end_line');
  });

  it('stays inside its allowance when the project table is multibyte', () => {
    workspace = makeWorkspace(`${TABLE}${'é中🧠'.repeat(PROJECT_TIPS_ALLOWANCE)}`);
    const block = loadCodingTips(workspace);
    const project = block?.sources.find((s) => s.kind === 'project');
    expect(
      Buffer.byteLength(project?.text ?? ''),
      'the clamp is in bytes, not characters',
    ).toBeLessThanOrEqual(PROJECT_TIPS_ALLOWANCE);
    expect(project?.text).not.toContain('\uFFFD');
  });

  it('does not consult the instruction chain: a huge FORGE.md still gets whole tips', () => {
    workspace = makeWorkspace(TABLE);
    // 60,000 bytes is past MAX_INSTRUCTION_BYTES (48,000): the chain truncates that
    // file, and the tips must arrive whole regardless.
    fs.writeFileSync(path.join(workspace, 'FORGE.md'), 'x'.repeat(60_000), 'utf8');
    const context = buildTemplateContext(
      { custom_instructions: '' } as ForgeConfig,
      { root: workspace, instructionsFor: () => 'x'.repeat(60_000) } as never,
      undefined,
      undefined,
      undefined,
      loadCodingTips(workspace)?.text,
    );
    expect(context['forgeInstructions']).toHaveLength(60_000);
    expect(context['codingTips']).toContain('a guessed end_line');
  });

  it('returns the same bytes twice, and new bytes only when a file changed', () => {
    workspace = makeWorkspace(TABLE);
    const first = loadCodingTips(workspace)?.text;
    const again = loadCodingTips(workspace)?.text;
    expect(again).toBe(first);
    fs.writeFileSync(
      path.join(workspace, 'docs', 'CODING_TIPS.md'),
      `${TABLE}## RUN\n2. new → noticed\n`,
      'utf8',
    );
    expect(loadCodingTips(workspace)?.text).not.toBe(first);
  });

  it('returns nothing when there is no table at all', () => {
    workspace = makeWorkspace(undefined);
    expect(loadCodingTips(workspace, path.join(workspace, 'missing.md'))).toBeUndefined();
  });
});

describe('the prompt carries the tips', () => {
  const config = { custom_instructions: '' } as ForgeConfig;

  it('adds a codingTips block to the template context the request renders with', () => {
    workspace = makeWorkspace(TABLE);
    const context = buildTemplateContext(
      config,
      { root: workspace, instructionsFor: () => undefined } as never,
      undefined,
      undefined,
      undefined,
      loadCodingTips(workspace)?.text,
    );
    expect(typeof context['codingTips']).toBe('string');
    expect(context['codingTips']).toContain('## READ');
  });

  it('keeps the block frozen for the chat when an agent records a tip mid-turn', () => {
    workspace = makeWorkspace(TABLE);
    const conv = { compaction: undefined } as never;
    const first = pinCodingTips(conv, workspace);
    // The whole point of the table is that an agent writes to it during a turn.
    fs.writeFileSync(
      path.join(workspace, 'docs', 'CODING_TIPS.md'),
      `${TABLE}## RUN\n2. a recorded tip → noticed later\n`,
      'utf8',
    );
    clearCodingTipsCache();
    expect(pinCodingTips(conv, workspace), 'a mid-turn edit must not rewrite the prompt head').toBe(
      first,
    );
  });

  it('renders the block in the shipped template under its own tag', () => {
    const template = fs.readFileSync(
      path.join(repoRoot, 'config', 'templates', 'builtin', 'execute.njk'),
      'utf8',
    );
    expect(template).toContain(`{% if codingTips %}<${CODING_TIPS_TAG}>`);
    expect(template).toContain('{{ codingTips }}');
  });
});

/**
 * The pin is runtime state that has to outlive the window that made it: a chat
 * that edits `docs/CODING_TIPS.md`, saves, and resumes must keep the block its
 * prompt head was built with, or the reload captures the new text and every
 * later request re-reads the prefix.
 */
describe('the pin survives a save and a reload', () => {
  function savedRecord(pin: { text: string; windowStart: number }) {
    const live: ConversationRuntime = {
      id: 'c1',
      title: 'Tips',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
      codingTipsPin: pin,
    };
    const saved = sidebarSessionPersistedSchema.parse(
      JSON.parse(
        JSON.stringify(
          runtimeToPersisted({ activeConversationId: 'c1', conversations: [live], history: [] }),
        ),
      ),
    );
    const record = saved.conversations[0];
    if (!record) throw new Error('the saved session lost its only conversation');
    return record;
  }

  it('is written and read back, so a reload cannot lose the frozen table', () => {
    const pin = { text: 'OLD TABLE', windowStart: 0 };
    const saved = savedRecord(pin);
    expect(saved.coding_tips_pin).toEqual(pin);
    expect(persistedToRuntime(saved).codingTipsPin).toEqual(pin);
  });

  it('keeps the reloaded pin when the window has not moved, not the table the agent just edited', () => {
    workspace = makeWorkspace(TABLE);
    const restored = persistedToRuntime(savedRecord({ text: 'OLD TABLE', windowStart: 0 }));
    expect(pinCodingTips(restored, workspace)).toBe('OLD TABLE');
  });

  it('renews the reloaded pin when a compaction moved the window while the chat was closed', () => {
    workspace = makeWorkspace(TABLE);
    const restored = persistedToRuntime(savedRecord({ text: 'OLD TABLE', windowStart: 0 }));
    restored.compaction = { summary: 'summary', fromIndex: 4, generation: 1 };
    expect(pinCodingTips(restored, workspace)).toContain('## READ');
  });

  /** A pin is only meaningful next to the compaction whose boundary it froze at, so
   *  this round-trips the two of them as one record rather than patching one on. */
  it('round-trips a pin with its compaction, and keeps the block after a real reload', () => {
    workspace = makeWorkspace(TABLE);
    const live: ConversationRuntime = {
      id: 'c1',
      title: 'Tips',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ],
      compaction: { summary: 'summary', fromIndex: 1, generation: 1 },
      codingTipsPin: { text: 'OLD TABLE', windowStart: 1 },
    };
    const saved = sidebarSessionPersistedSchema.parse(
      JSON.parse(
        JSON.stringify(
          runtimeToPersisted({ activeConversationId: 'c1', conversations: [live], history: [] }),
        ),
      ),
    );
    const restored = persistedToRuntime(saved.conversations[0]!);
    expect(restored.compaction?.fromIndex).toBe(1);
    expect(restored.codingTipsPin).toEqual({ text: 'OLD TABLE', windowStart: 1 });
    expect(pinCodingTips(restored, workspace)).toBe('OLD TABLE');
  });

  it('does not mark a reloaded chat dirty while its pinned block stands, and does once it renews', () => {
    workspace = makeWorkspace(TABLE);
    const restored = persistedToRuntime(savedRecord({ text: 'OLD TABLE', windowStart: 0 }));
    const asSaved = openConversationSignature(restored);
    pinCodingTips(restored, workspace);
    expect(openConversationSignature(restored), 'nothing changed: no save owed').toBe(asSaved);
    restored.compaction = { summary: 'summary', fromIndex: 4, generation: 1 };
    const afterCompaction = openConversationSignature(restored);
    pinCodingTips(restored, workspace);
    expect(openConversationSignature(restored), 'the block renewed: a save is owed').not.toBe(
      afterCompaction,
    );
    const afterRenew = openConversationSignature(restored);
    pinCodingTips(restored, workspace);
    expect(openConversationSignature(restored), 'already renewed: nothing more to write').toBe(
      afterRenew,
    );
  });

  it('renews the pin in the turn compaction moves the window, not in the next one', () => {
    workspace = makeWorkspace(TABLE);
    const conv = persistedToRuntime(savedRecord({ text: 'OLD TABLE', windowStart: 0 }));
    expect(pinCodingTips(conv, workspace)).toBe('OLD TABLE');
    conv.compaction = { summary: 'summary', fromIndex: 4, generation: 1 };
    fs.writeFileSync(
      path.join(workspace, 'docs', 'CODING_TIPS.md'),
      `${TABLE}## RUN\n2. a tip recorded mid-turn → reaches the model at the window\n`,
      'utf8',
    );
    clearCodingTipsCache();
    expect(pinCodingTips(conv, workspace)).toContain('reaches the model at the window');
    expect(conv.codingTipsPin?.windowStart).toBe(4);
  });

  it('refuses a pin body no loader could have written, and a pin with an unknown key', () => {
    const base = { id: 'c1', title: 't', createdAt: 1, updatedAt: 2, messages: [] };
    expect(
      conversationPersistedBaseSchema.safeParse({
        ...base,
        coding_tips_pin: { text: 'x'.repeat(TIPS_PIN_TEXT_MAX_CHARS + 1), windowStart: 0 },
      }).success,
    ).toBe(false);
    expect(
      conversationPersistedBaseSchema.safeParse({
        ...base,
        coding_tips_pin: { text: 'x', windowStart: 0, extra: 1 },
      }).success,
    ).toBe(false);
  });

  it('admits the largest block a loader can actually write', () => {
    // The ceiling and the allowances are the two ends of one contract: a block
    // `loadCodingTips` produces must survive the pin schema, or every chat body
    // carrying it is quarantined at load. Both tables are written past their
    // allowances so each arrives at exactly its allowance, which is the biggest
    // block the loader can emit.
    workspace = makeWorkspace('b'.repeat(PROJECT_TIPS_ALLOWANCE + 500));
    const base = { id: 'c1', title: 't', createdAt: 1, updatedAt: 2, messages: [] };
    const shippedFile = path.join(workspace, 'shipped-at-allowance.md');
    fs.writeFileSync(shippedFile, 'a'.repeat(SHIPPED_TIPS_ALLOWANCE + 500), 'utf8');
    const block = loadCodingTips(workspace, shippedFile);
    expect(block?.sources.map((s) => s.kind)).toEqual(['shipped', 'project']);
    const text = block?.text ?? '';
    expect(text.length, 'a block at both allowances must fit the pin ceiling').toBeLessThanOrEqual(
      TIPS_PIN_TEXT_MAX_CHARS,
    );
    expect(
      conversationPersistedBaseSchema.safeParse({
        ...base,
        coding_tips_pin: { text, windowStart: 0 },
      }).success,
      'the schema must accept what the loader can produce',
    ).toBe(true);
  });
});

/**
 * The pin only pays for itself if the value a round passes reaches that round's
 * prompt: `ModelTurn.ts` re-evaluates it per round, and this is the seam between
 * that call and the rendered system message.
 */
describe('the tips reach the prompt on the round that supplied them', () => {
  const model = { name: 'tips-test', num_ctx: 32_768, n_parallel: 1 } as ModelConfig;
  const templateEngine = {
    render: (_name: string, ctx: Record<string, unknown>) =>
      `tips=${String(ctx['codingTips'] ?? '')}`,
  } as unknown as TemplateEngine;

  function run(codingTips: string | undefined): unknown {
    return prepareModelTurnMessages([{ role: 'user', content: 'hi' }], {
      compaction: undefined,
      contextTrimState: createContextTrimState(),
      isVisionModel: false,
      model,
      templateEngine,
      config: { models: [model] } as unknown as ForgeConfig,
      forgeLoader: {
        root: 'N:/nowhere',
        instructionsFor: () => undefined,
      } as unknown as ForgeInstructionsLoader,
      activeFile: undefined,
      workspaceIsProjectRoot: true,
      codingTips,
      turnContext: {},
      getToolDefinitions: () => [],
    }).messages[0]?.content;
  }

  it('renders what this round passed, and a renewed block on the next round', () => {
    expect(run('OLD BLOCK')).toBe('tips=OLD BLOCK');
    expect(run('RENEWED BLOCK')).toBe('tips=RENEWED BLOCK');
    expect(run(undefined)).toBe('tips=');
  });
});
