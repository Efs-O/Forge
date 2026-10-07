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

  it('lets a user-specified answer format win', () => {
    expect(prompt).toContain('If the user specified a format, follow theirs exactly');
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
    expect(injectTurnContext(user, {})).toEqual(user);
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
