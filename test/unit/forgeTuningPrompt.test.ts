import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TemplateEngine } from '../../src/llm/TemplateEngine';
import type { ForgeConfig } from '../../src/config/types';
import type { ForgeInstructionsLoader } from '../../src/llm/ForgeInstructionsLoader';
import { buildTemplateContext } from '../../src/sidebar/turnModelBehavior';
import { injectTurnContext } from '../../src/sidebar/turnContext';
import { withUnattendedRefusals } from '../../src/sidebar/unattendedConversations';
import { PLAN_GUIDANCE } from '../../src/tools/planTools';

// docs/plans/FORGE_TUNING_PLAN.md: prompt text that cost rounds and bought nothing.

const builtinDir = path.join(__dirname, '..', '..', 'config', 'templates', 'builtin');
const NESTED = 'Keep the nested directory prefix on paths';

function loaderFor(root: string): ForgeInstructionsLoader {
  return { root, instructionsFor: () => undefined } as unknown as ForgeInstructionsLoader;
}

function renderFor(root: string): string {
  const context = buildTemplateContext({} as ForgeConfig, loaderFor(root), undefined);
  return new TemplateEngine(builtinDir).render('execute', context);
}

describe('workspace root line', () => {
  it('says the root is the project when it holds package.json or .git', () => {
    for (const marker of ['package.json', '.git']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-root-'));
      try {
        fs.writeFileSync(path.join(dir, marker), '{}');
        const prompt = renderFor(dir);
        expect(prompt).toContain('It is the project root');
        expect(prompt).toContain('find_files` `pattern` resolves from it');
        expect(prompt).not.toContain(NESTED);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('uses the turn-start snapshot over the disk, so a mid-turn git init changes nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-root-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      const context = buildTemplateContext({} as ForgeConfig, loaderFor(dir), undefined, false);
      expect(context['workspaceIsProjectRoot']).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the nested-prefix instruction for a workspace holding a nested project', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-root-'));
    try {
      const prompt = renderFor(dir);
      expect(prompt).toContain(NESTED);
      expect(prompt).not.toContain('It is the project root');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('builtin execute template', () => {
  const prompt = new TemplateEngine(builtinDir).render('execute', {});

  it('applies the P1-P13 owner decisions', () => {
    for (const removed of [
      'local AI coding assistant running entirely on the user',
      'Use edit_file with exact old_str matches',
      'Stop and ask after 3 failed attempts',
      'considered a hypothesis twice',
      'Never suggest cloud services or external APIs',
      'Prefer search_code/find_files/read_file for reading code',
      'use search_code/find_files/read_file for reading code',
      'Be brief. Think only as long as the next action needs',
      'Before you call a change done, run the narrowest check',
      // Injected-text fixes: the destructive-command outcome is the turn
      // context's to state (approval, or denial when unattended).
      'always require the user',
      'Search many files in one command',
      'Always read a file before editing it',
    ]) {
      expect(prompt).not.toContain(removed);
    }
    expect(prompt).toContain("a coding assistant running in the user's VS Code");
    expect(prompt).toContain(
      'Read a file before editing it, unless its current content is already in a recent tool result',
    );
    expect(prompt).toContain('To locate code, use search_code');
    expect(prompt).toContain('ripgrep regex; `literal: true` for plain text');
    expect(new TemplateEngine(builtinDir).render('execute', { workspaceRoot: 'N:/ws' })).toContain(
      'find_files` `pattern` resolves from this root',
    );
    expect(prompt).not.toContain('narrowest check');
    expect(prompt).not.toContain('smallest change');
    expect(prompt).toContain(
      'for code, run the tests that cover it; for anything visual, look carefully at the rendered result for imperfections.',
    );
    // The scope guard read as "stay minimal" on one-shot builds (pelican run 5 vs 0.17.0).
    expect(prompt).not.toContain('Do not refactor, clean up');
    expect(prompt).toContain('- Within the task, do the work completely and very well.');
    expect(prompt).toContain('Write the direct answer as a standalone first sentence');
    expect(prompt).toContain('leave a blank line before short plain headings or bullets');
    expect(prompt).toContain(
      'After each result, determine what specific information or action is still required. If something necessary remains, continue.',
    );
    expect(prompt).toContain('Search the workspace or a named folder, never a whole drive.');
    // Review before the render: run 9 rendered, saw unattached legs, and the task's no-iterate rule blocked the fix.
    expect(prompt).toContain(
      'First review what you wrote once against the request: every requested part present, every part connected to what it depends on; fix what you find. Then, for code',
    );
    // 2026 prompt-guide pass: positive phrasing, a reason on key rules, root cause over shortcuts.
    expect(prompt).not.toContain('You have access to tools');
    // Run 9 reasoned "To keep it simple: two leg groups rotating" — risk-aversion when it cannot iterate.
    expect(prompt).not.toContain('Where a correct method exists');
    expect(prompt).toContain(
      'When you cannot test or iterate, choose the approach that is correct and best, not the one easiest to get right blind',
    );
    expect(prompt).toContain('Fix the cause, not the symptom');
    expect(prompt).toContain('each round is a full model pass');
    expect(prompt).toContain('Base every claim on what you have seen in a tool result');
    expect(prompt).toContain("The user's instructions, in the first message or any later message");
    expect(prompt).toContain(
      'Tool permissions, approvals and the destructive-command rule never yield.',
    );
    expect(prompt).toContain('If an instruction stopped you verifying, say in the final answer');
    expect(prompt).toContain(
      'Before finishing, stop any server or background job you started, unless the user asked to keep it.',
    );
    expect(prompt).toContain(
      'Before adding a function, module or dependency to an existing codebase, search for one that already does it.',
    );
    expect(prompt).toContain('Never run destructive commands');
    expect(prompt).toContain('write code into files with write_file or edit_file');
    expect(prompt).toContain('Final answer: at most 12 lines.');
    // When to preview is the agent's call; the tool description says what preview shows.
    expect(prompt).not.toContain('render_html_to_image');
    expect(prompt).toContain('a preview result is a tool result');
  });

  it('lets a user-specified answer format win', () => {
    expect(prompt).toContain(
      'If the user asks for exhaustive detail or specifies a format, follow that request exactly.',
    );
    expect(prompt).toContain('Write the direct answer as a standalone first sentence');
    expect(prompt).toContain('Keep one point per bullet');
  });

  it('leaves fallback-format and terminal guidance to the code that injects them', () => {
    // withFallbackToolInstructions and renderUserTerminalCommands carry these
    // exactly when they apply; a copy here is paid on every turn.
    expect(prompt).not.toContain('native tool calling is unavailable');
    expect(prompt).not.toContain("user's terminal commands");
  });
});

describe('unattended turns', () => {
  const user = [{ role: 'user' as const, content: 'audit src/tools' }];

  it('states the denial policy up front, and only when unattended', () => {
    const content = String(injectTurnContext(user, { unattended: true })[0]?.content);
    expect(content).toContain('denied, not sent for approval');
    expect(content).toContain('delete_file');
    // One call with paths, not one call per file (minecraft r1: 19 deletes).
    expect(content).toContain("one delete_file call's paths");
    expect(content).not.toContain('one by one');
    expect(injectTurnContext(user, {})).toEqual(user);
  });

  it("does not call the model's own plan notes an authoritative specification", () => {
    expect(PLAN_GUIDANCE).not.toContain('authoritative specification');
    expect(PLAN_GUIDANCE).toContain("your record of this task's requirements");
    expect(PLAN_GUIDANCE).toContain('change it with update_plan');
  });

  it('withholds ask_user, keeping any other refusal', () => {
    const vision = new Map([['view_image', 'no projector']]);
    const merged = withUnattendedRefusals(vision, true);
    expect(merged?.get('ask_user')).toContain('nobody is present');
    expect(merged?.get('view_image')).toBe('no projector');
    expect(withUnattendedRefusals(vision, false)).toBe(vision);
    expect(withUnattendedRefusals(undefined, false)).toBeUndefined();
  });
});
