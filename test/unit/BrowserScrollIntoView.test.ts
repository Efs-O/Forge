import { describe, expect, it, vi } from 'vitest';
import { makeBrowserActionTools } from '../../src/tools/browser/browserActionTools';
import type { BrowserToolContext } from '../../src/tools/browser/browserTools';

function scrollTool(mgr: Record<string, ReturnType<typeof vi.fn>>) {
  const context = {
    mgr,
    inputApproval: () => () => undefined,
    markTargetOrigin: () => undefined,
    str: (args: Record<string, unknown>, key: string) =>
      typeof args[key] === 'string' ? (args[key] as string) : undefined,
  } as unknown as BrowserToolContext;
  const tool = makeBrowserActionTools(context).find(
    (candidate) => candidate.definition.function.name === 'browser_scroll',
  );
  if (!tool) throw new Error('browser_scroll was not registered');
  return tool;
}

describe('browser_scroll into_view', () => {
  it('resolves an inspect index through the manager element reference', async () => {
    const scrollIntoView = vi.fn(async () => 'scrolled target into view');
    const scroll = vi.fn(async () => 'scrolled by amount');
    const tool = scrollTool({ scroll, scrollIntoView });

    await expect(tool.handler({ into_view: { index: 4 } })).resolves.toBe(
      'scrolled target into view',
    );
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith(undefined, { index: 4 });
    expect(scroll).not.toHaveBeenCalled();
  });

  it('refuses into_view with either scroll amount and names all arguments exactly', async () => {
    const scrollIntoView = vi.fn(async () => 'scrolled target into view');
    const scroll = vi.fn(async () => 'scrolled by amount');
    const tool = scrollTool({ scroll, scrollIntoView });

    let refusal = '';
    try {
      await tool.handler({ into_view: { selector: '#target' }, delta_y: 240 });
    } catch (err) {
      refusal = (err as Error).message;
    }

    expect(refusal).toBe('browser_scroll: into_view cannot be combined with delta_x or delta_y.');
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scroll).not.toHaveBeenCalled();
  });

  it('declares a strict selector-or-index element reference', () => {
    const tool = scrollTool({ scroll: vi.fn(), scrollIntoView: vi.fn() });
    const properties = tool.definition.function.parameters.properties as Record<string, unknown>;

    expect(properties.into_view).toEqual({
      type: 'object',
      description: 'Element reference: provide exactly one of selector or index.',
      properties: {
        selector: { type: 'string', description: 'CSS selector to bring into view.' },
        index: { type: 'number', description: 'Index from browser_inspect.' },
      },
      additionalProperties: false,
    });
  });
});
