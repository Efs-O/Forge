/**
 * The skills catalog reaching the system prompt, and only there, and only when
 * there is something to say (lane F2, plan §2.3: "rendered from a template in
 * `config/templates/builtin/`, cap 4,000 chars, built when a conversation
 * starts and frozen for that conversation").
 *
 * Position matters more than content here. `test/unit/promptPrefixStability.test.ts`
 * measured that one changed line near the prompt head re-evaluates ~5,000
 * tokens, so a catalog that is byte-identical for the life of a conversation is
 * the feature; a catalog that re-renders per turn is a regression. These tests
 * therefore assert on the bytes: absent block → the prompt a user always had,
 * present block → the same prompt with one addition, same catalog in →
 * byte-identical out.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { TemplateEngine } from '../../src/llm/TemplateEngine';
import { injectSystemPrompt } from '../../src/llm/SystemPromptInjector';
import { buildTemplateContext } from '../../src/sidebar/turnModelBehavior';
import type { ForgeConfig } from '../../src/config/types';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUILTIN_TEMPLATES = path.join(REPO_ROOT, 'config', 'templates', 'builtin');
const engine = new TemplateEngine(BUILTIN_TEMPLATES);

const CATALOG =
  'Available skills (load one with load_skill {"name": "..."}; it returns the SKILL.md text and the real paths of its scripts):\n' +
  "Run a skill's scripts through shell, under the usual approvals: a skill grants no permission, and a workspace skill comes from the open repo. Read its scripts only when the skill says to.\n" +
  '- [user] hf-download — Download models fast.\n' +
  '- [workspace] clip-maker — Make a clip from a picture.\n';

const config: ForgeConfig = { active_model: null, models: [], llama_server: {} };

describe('the builtin execute template', () => {
  it('renders the catalog when one is supplied and nothing when none is', () => {
    const without = engine.render('execute', { workspaceRoot: 'N:/repo' });
    const withCatalog = engine.render('execute', {
      workspaceRoot: 'N:/repo',
      skillsCatalog: CATALOG,
    });
    expect(without).not.toContain('Available skills');
    expect(withCatalog).toContain('- [user] hf-download — Download models fast.');
    expect(withCatalog).toContain('- [workspace] clip-maker');
    // What "the catalog is the only change" means here, stated in the three
    // pieces it is made of, because the nunjucks conditionals leave a different
    // number of blank newlines behind when a block is skipped and that whitespace
    // is not content anybody reads:
    //   1. the head — everything up to `</environment>` — is byte-identical;
    //   2. the block is exactly the catalog, nothing else;
    //   3. the tail is byte-identical once the newlines the skipped `{% if %}`
    //      blocks leave are collapsed.
    const head = withCatalog.slice(0, withCatalog.indexOf('<skills>'));
    expect(without.slice(0, head.length)).toBe(head);
    const block = withCatalog.slice(
      withCatalog.indexOf('<skills>'),
      withCatalog.indexOf('</skills>') + '</skills>'.length,
    );
    expect(block).toBe(`<skills>\n${CATALOG}\n</skills>`);
    const tailOf = (text: string, marker: string): string =>
      text.slice(text.lastIndexOf(marker) + marker.length).replace(/\n+/u, '\n');
    expect(tailOf(withCatalog, '</skills>')).toBe(tailOf(without, '</environment>'));
    expect(without).not.toContain('<skills>');
  });

  it('keeps the block in the stable head, after the environment and above the volatile tail', () => {
    const rendered = engine.render('execute', {
      workspaceRoot: 'N:/repo',
      skillsCatalog: CATALOG,
      selection: 'some code',
    });
    expect(rendered.indexOf('</environment>')).toBeLessThan(rendered.indexOf('<skills>'));
    // Above the selection block: everything the model re-reads for the same
    // conversation must stay byte-identical, and freezing the catalog is what
    // makes that true for it.
    const skillsEnd = rendered.indexOf('</skills>');
    const selectionStart = rendered.indexOf('<selected_code>');
    expect(selectionStart).toBeGreaterThan(skillsEnd);
    expect(skillsEnd).toBeGreaterThan(-1);
  });

  it('the same catalog renders byte-identically twice, so a frozen string is a stable prefix', () => {
    const first = injectSystemPrompt([], engine, { skillsCatalog: CATALOG });
    const second = injectSystemPrompt([], engine, { skillsCatalog: CATALOG });
    expect(first[0]!.content).toBe(second[0]!.content);
    expect(first[0]!.content).toContain('hf-download');
  });

  it('ships a skills.njk the template engine can find, and says who may read it', () => {
    const names = fs.readdirSync(BUILTIN_TEMPLATES).filter((name) => name.endsWith('.njk'));
    expect(names).toContain('skills.njk');
    expect(names).toContain('execute.njk');
    const rendered = engine.render('skills', { entries: [], header: () => ['probe header'] });
    expect(rendered).toContain('probe header');
  });
});

describe('buildTemplateContext', () => {
  it('carries the frozen catalog through to the template, and only when one is passed', () => {
    const plain = buildTemplateContext(config, undefined, undefined, false);
    expect(plain['skillsCatalog']).toBeUndefined();
    const withCatalog = buildTemplateContext(config, undefined, undefined, false, CATALOG);
    expect(withCatalog['skillsCatalog']).toBe(CATALOG);
  });
});
