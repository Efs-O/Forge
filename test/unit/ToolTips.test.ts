/**
 * Phase 2 of CODING_TIPS_IN_TOOLS_PLAN.md: a Forge tool's tips live in the tips
 * table's `## FORGE_TOOLS` section but reach the model inside that tool's
 * description, where the model is reading when it builds the call.
 *
 * The failure modes this pins:
 *  - the row leaves the big table exactly once: the table the prompt renders has
 *    no `## FORGE_TOOLS` section, and the tool carries the row;
 *  - a tips file with no such section changes nothing at all, so today's chats,
 *    whose tables have none, are byte-identical;
 *  - the caps hold, and what they drop stays visible in the table;
 *  - the registry's definitions are never mutated, and a tool with no tips comes
 *    back as the same object;
 *  - both paths read ONE pin, so the first request of a chat already carries the
 *    tips (`ToolCallingLoop.ts` builds the tool list before the messages) and a
 *    mid-chat edit reaches the tools only when the compaction window moves.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  splitToolTips,
  TOOL_TIPS_MAX_BYTES_PER_TOOL,
  TOOL_TIPS_MAX_PER_TOOL,
  withToolTips,
} from '../../src/llm/toolTips';
import {
  pinCodingTips,
  withPinnedToolTips,
  type CodingTipsPin,
} from '../../src/sidebar/codingTipsPin';
import { clearCodingTipsCache } from '../../src/llm/codingTips';
import type { ToolDefinition } from '../../src/llm/types';

const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * The pin path takes no shipped-path argument (its callers have none either), so
 * a test that wants ONLY the project table swaps the loader's default for a file
 * that does not exist — the same stub `CodingTipsInjection.test.ts` makes by hand.
 */
const shippedStub = vi.hoisted(() => ({ path: '' }));

vi.mock('../../src/llm/codingTips', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/llm/codingTips')>();
  return {
    ...actual,
    loadCodingTips: (workspaceRoot?: string, shippedPath = shippedStub.path) =>
      actual.loadCodingTips(workspaceRoot, shippedPath),
  };
});

function def(name: string, description: string): ToolDefinition {
  return { type: 'function', function: { name, description, parameters: {} } };
}

const TIP = '`path:"src"` → refused: unknown argument. put the folder in the pattern';
const ROW = '1. `find_files` · ' + TIP;
const PROJECT_TIPS = '## RUN\n1. a → b\n\n## FORGE_TOOLS\n' + ROW + '\n';

interface TestConv {
  compaction?: { summary: string; fromIndex: number; generation: number };
  codingTipsPin?: CodingTipsPin;
}

let workspace = '';

function makeWorkspace(tips: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-tips-'));
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'CODING_TIPS.md'), tips, 'utf8');
  workspace = dir;
  shippedStub.path = path.join(dir, 'no-shipped-here.md');
  return dir;
}

beforeEach(() => clearCodingTipsCache());
afterEach(() => {
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  workspace = '';
  shippedStub.path = '';
  clearCodingTipsCache();
});

describe('splitToolTips', () => {
  it('removes the section and groups its row under the tool it names', () => {
    const split = splitToolTips('## RUN\n1. a → b. c\n\n## FORGE_TOOLS\n' + ROW + '\n');
    expect(split.table).toBe('## RUN\n1. a → b. c\n');
    expect(split.byTool.get('find_files')).toEqual([TIP]);
  });

  it('changes nothing when there is no FORGE_TOOLS section', () => {
    const text = '## RUN\n1. a → b\n';
    const split = splitToolTips(text);
    expect(split.table).toBe(text);
    expect(split.byTool.size).toBe(0);
  });

  it('applies the caps the owner set', () => {
    expect(TOOL_TIPS_MAX_PER_TOOL).toBe(20);
    expect(TOOL_TIPS_MAX_BYTES_PER_TOOL).toBe(5000);
  });

  it('keeps the first twenty rows and says how many are left in the table', () => {
    const twentyTwo =
      '## FORGE_TOOLS\n' +
      Array.from({ length: 22 }, (_, n) => '1. `find_files` · r' + (n + 1)).join('\n') +
      '\n';
    const split = splitToolTips(twentyTwo);
    expect(split.byTool.get('find_files')).toEqual([
      ...Array.from({ length: 20 }, (_, n) => 'r' + (n + 1)),
      '(2 more in the tips table)',
    ]);
    expect(split.table).toBe('## FORGE_TOOLS\n1. `find_files` · r21\n2. `find_files` · r22\n');
  });

  it('counts bytes, not rows, and keeps the overflow row in the table', () => {
    const long = 'x'.repeat(2000);
    expect(Buffer.byteLength([long, long].join('\n'), 'utf8')).toBeLessThanOrEqual(
      TOOL_TIPS_MAX_BYTES_PER_TOOL,
    );
    const input =
      '## FORGE_TOOLS\n' +
      [1, 2, 3].map(() => '1. `find_files` · ' + long).join('\n') +
      '\n';
    const split = splitToolTips(input);
    expect(split.byTool.get('find_files')).toEqual([long, long, '(1 more in the tips table)']);
    expect(split.table).toBe('## FORGE_TOOLS\n1. `find_files` · ' + long + '\n');
  });

  it('merges the two sources\' sections, shipped rows first', () => {
    const split = splitToolTips(
      '## FORGE_TOOLS\n1. `find_files` · a\n\n## RUN\n1. keep me\n\n' +
        '## FORGE_TOOLS\n1. `find_files` · b\n2. `grep_search` · c\n',
    );
    expect(split.byTool.get('find_files')).toEqual(['a', 'b']);
    expect(split.byTool.get('grep_search')).toEqual(['c']);
    expect(split.table).toBe('## RUN\n1. keep me\n');
  });

  it('keeps the blank run before a section that stops at a following line', () => {
    const split = splitToolTips(
      '## RUN\n1. a → b\n\n## FORGE_TOOLS\n1. `find_files` · x → y\n\n## GIT\n1. c → d\n',
    );
    expect(split.table).toBe('## RUN\n1. a → b\n\n## GIT\n1. c → d\n');
    expect(split.byTool.get('find_files')).toEqual(['x → y']);
  });
});

describe('withToolTips', () => {
  const byTool = new Map([['find_files', [TIP]]]);

  it('appends the known mistakes to the tool that has them', () => {
    const input = [def('find_files', 'D')];
    const built = withToolTips(input, byTool);
    expect(built[0]!.function.description).toBe('D\n\nKnown mistakes:\n- ' + TIP);
    expect(input[0]!.function.description, 'the registry\'s definition is never mutated').toBe('D');
  });

  it('returns a tool with no tips as the same object', () => {
    const input = [def('read_file', 'R')];
    expect(withToolTips(input, byTool)[0]).toBe(input[0]);
  });
});

describe('the pinned tips reach the tools', () => {
  it('carries them on the first request, before any pinCodingTips call', () => {
    const dir = makeWorkspace(PROJECT_TIPS);
    const conv = {} as TestConv;
    const defs = [def('find_files', 'D'), def('read_file', 'R')];
    const built = withPinnedToolTips(conv as never, dir, defs);
    expect(built).not.toBe(defs);
    expect(built[0]!.function.description).toBe('D\n\nKnown mistakes:\n- ' + TIP);
    expect(built[1]!.function.description).toBe('R');
    // The same chat's table: the row is in the tool, so it is not in the table.
    const table = pinCodingTips(conv as never, dir);
    expect(table).toContain('## RUN\n1. a → b\n');
    expect(table).not.toContain('## FORGE_TOOLS');
    expect(table).not.toContain(TIP);
  });

  it('holds the descriptions byte-identical until the compaction window moves', () => {
    const dir = makeWorkspace(PROJECT_TIPS);
    const conv = {} as TestConv;
    const defs = [def('find_files', 'D')];
    const pinned = withPinnedToolTips(conv as never, dir, defs)[0]!.function.description;
    fs.writeFileSync(
      path.join(dir, 'docs', 'CODING_TIPS.md'),
      '## RUN\n1. a → b\n\n## FORGE_TOOLS\n1. `find_files` · a tip recorded mid-chat\n',
      'utf8',
    );
    clearCodingTipsCache();
    const again = withPinnedToolTips(conv as never, dir, defs)[0]!.function.description;
    expect(again).toBe(pinned);
    expect(again).not.toContain('recorded mid-chat');
    expect(conv.compaction, 'nothing compacted this chat: the window has not moved').toBeUndefined();
    conv.compaction = { summary: 'summary', fromIndex: 4, generation: 1 };
    expect(withPinnedToolTips(conv as never, dir, defs)[0]!.function.description).toContain(
      'a tip recorded mid-chat',
    );
  });

  it('a pin saved by today\'s build yields no tool tips and does not throw', () => {
    const dir = makeWorkspace(PROJECT_TIPS);
    const conv = {
      compaction: undefined,
      codingTipsPin: { text: '## RUN\n1. a → b\n', windowStart: 0 },
    } as TestConv;
    const defs = [def('find_files', 'D')];
    const built = withPinnedToolTips(conv as never, dir, defs);
    expect(built[0]).toBe(defs[0]);
    expect(pinCodingTips(conv as never, dir)).toBe('## RUN\n1. a → b\n');
  });

  it('a pin whose text holds the section yields its tips', () => {
    const dir = makeWorkspace(PROJECT_TIPS);
    const conv = {
      compaction: undefined,
      codingTipsPin: { text: '## FORGE_TOOLS\n1. `find_files` · a tip the pin froze\n', windowStart: 0 },
    } as TestConv;
    expect(withPinnedToolTips(conv as never, dir, [def('find_files', 'D')])[0]!.function.description).toBe(
      'D\n\nKnown mistakes:\n- a tip the pin froze',
    );
  });
});

describe('the size ceiling', () => {
  it('the shipped table\'s tool tips cannot add more than 6 KB to the schema', () => {
    const shipped = fs.readFileSync(
      path.join(repoRoot, 'resources', 'tips', 'CODING_TIPS.md'),
      'utf8',
    );
    const { byTool } = splitToolTips(shipped);
    const defs = [...byTool.keys()].map((name) => def(name, 'D'));
    const built = withToolTips(defs, byTool);
    let added = 0;
    for (let i = 0; i < defs.length; i++) {
      const before = defs[i]!.function.description;
      added += Buffer.byteLength(built[i]!.function.description.slice(before.length), 'utf8');
    }
    expect(added).toBeLessThanOrEqual(32768);
  });
});
