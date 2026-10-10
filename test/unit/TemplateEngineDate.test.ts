import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TemplateEngine } from '../../src/llm/TemplateEngine';

/**
 * A model with no clock cannot date anything it writes. On 2026-09-05 an agent
 * needed today's date to update a comment in config.yaml, reached for
 * `powershell -Command "Get-Date"` (banned — a model-authored script cannot be
 * checked by the denylist), and spent a round recovering via `node -e`. The
 * date belongs in the prompt, not behind a tool call.
 */
describe('TemplateEngine currentDate', () => {
  const makeEngine = (body: string): { engine: TemplateEngine; dir: string } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-template-'));
    fs.writeFileSync(path.join(dir, 'execute.njk'), body, 'utf8');
    return { engine: new TemplateEngine(dir), dir };
  };

  it('injects today without the caller passing it', () => {
    const { engine, dir } = makeEngine('date={{ currentDate }}');
    try {
      expect(engine.render('execute', {})).toMatch(/^date=\d{4}-\d{2}-\d{2}$/u);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a date, never a time — the system prompt is the KV cache prefix', () => {
    const { engine, dir } = makeEngine('{{ currentDate }}');
    try {
      const first = engine.render('execute', {});
      expect(engine.render('execute', {})).toBe(first);
      expect(first).not.toMatch(/:/u);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets a caller override it, and leaves other context alone', () => {
    const { engine, dir } = makeEngine('{{ currentDate }}|{{ workspaceRoot }}');
    try {
      expect(engine.render('execute', { currentDate: '1999-12-31', workspaceRoot: '/w' })).toBe(
        '1999-12-31|/w',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ships the date in the real execute template', () => {
    const builtin = path.resolve(__dirname, '../../config/templates/builtin');
    const engine = new TemplateEngine(builtin);
    const rendered = engine.render('execute', { workspaceRoot: '/w' });
    expect(rendered).toContain("Today's date is ");
    expect(rendered).toMatch(/Today's date is \d{4}-\d{2}-\d{2}\./u);
  });
});
