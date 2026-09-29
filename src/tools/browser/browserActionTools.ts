import type { ContentPart } from '../../llm/types';
import type { MultimodalToolResult, RegisteredTool } from '../ToolRegistry';
import { saveScreenshot, tabLabel, visionRefusal, type BrowserToolContext } from './browserTools';

/**
 * The browser interaction tools (plan §4.2): screenshot, inspect, click, type,
 * press, scroll, hover, drag. They share the `BrowserToolContext` built by
 * `makeBrowserTools`; the screenshot tool is the only `requiresVision` one in
 * the family (B8 single source). Splits from browserTools.ts to stay under the
 * line limit.
 */
export function makeBrowserActionTools(ctx: BrowserToolContext): RegisteredTool[] {
  const num = (args: Record<string, unknown>, key: string): number | undefined =>
    typeof args[key] === 'number' ? (args[key] as number) : undefined;

  return [
    {
      definition: {
        type: 'function',
        function: {
          name: 'browser_screenshot',
          description:
            'Capture the active (or named) tab as an image and return it inline to you. ' +
            'full_page=true captures the whole scrollable page. Returns the image plus the ' +
            'saved path, actual dimensions, and the coordinate space.',
          parameters: {
            type: 'object',
            properties: {
              tab_id: { type: 'string', description: 'Optional tab id (default: active tab).' },
              full_page: {
                type: 'boolean',
                description: 'Capture the full page, not just the viewport.',
              },
            },
            additionalProperties: false,
          },
        },
      },
      permission: 'browser',
      autoApprove: true,
      requiresVision: (name) => visionRefusal(name),
      handler: async (args, toolCtx): Promise<MultimodalToolResult> => {
        const tabId = ctx.str(args, 'tab_id');
        const fullPage = args.full_page === true;
        const shot = await ctx.mgr.screenshot(tabId, fullPage);
        const tabs = await ctx.mgr.tabs();
        const active = tabs.find((t) => t.active) ?? tabs[0];
        const saved = await saveScreenshot(toolCtx?.conversationId, shot.png);
        const coordNote = fullPage
          ? 'coord_space=image_px (FULL PAGE — x,y coordinate actions use viewport space, not this image; use a viewport screenshot or scroll for x,y)'
          : 'coord_space=image_px (x,y in this image match the viewport)';
        const text =
          `Screenshot of tab ${tabLabel(active)}, ${shot.width}×${shot.height} px, ` +
          `${coordNote}. Saved to ${saved}.`;
        const content: ContentPart[] = [
          { type: 'text', text },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${shot.png.toString('base64')}` },
          },
        ];
        return { text, content };
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'browser_inspect',
          description:
            'List the interactive elements (links, buttons, inputs, …) on the active/named ' +
            'tab as a numbered list with {index, role, text, selector, bbox}. Use the index or ' +
            'selector in browser_click / browser_type / browser_hover.',
          parameters: {
            type: 'object',
            properties: {
              tab_id: { type: 'string', description: 'Optional tab id (default: active tab).' },
              max: { type: 'number', description: 'Maximum elements to list (default 50).' },
            },
            additionalProperties: false,
          },
        },
      },
      permission: 'browser',
      autoApprove: true,
      handler: async (args) => {
        const max = typeof args.max === 'number' && args.max > 0 ? Math.floor(args.max) : 50;
        const els = await ctx.mgr.inspect(ctx.str(args, 'tab_id'), max);
        if (els.length === 0) return 'No interactive elements found on this page.';
        return els
          .map(
            (e) =>
              `[${e.index}] ${e.role} "${e.text}" — ${e.selector} ` +
              `(${Math.round(e.bbox.x)},${Math.round(e.bbox.y)} ${Math.round(e.bbox.width)}×${Math.round(e.bbox.height)})`,
          )
          .join('\n');
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'browser_click',
          description:
            'Click on the active/named tab by selector, by inspect index, or by viewport x,y. ' +
            'Set consequential=true if the click submits a form, makes a purchase, sends a ' +
            'message, or deletes data.',
          parameters: {
            type: 'object',
            properties: {
              tab_id: { type: 'string' },
              selector: { type: 'string', description: 'CSS selector to click.' },
              index: { type: 'number', description: 'Index from browser_inspect.' },
              x: { type: 'number', description: 'Viewport x coordinate.' },
              y: { type: 'number', description: 'Viewport y coordinate.' },
              consequential: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
      },
      permission: 'browser',
      autoApprove: true,
      approval: ctx.inputApproval('browser_click'),
      handler: async (args) => {
        ctx.markTargetOrigin(args);
        const result = await ctx.mgr.click(ctx.str(args, 'tab_id'), {
          selector: ctx.str(args, 'selector'),
          index: num(args, 'index'),
          x: num(args, 'x'),
          y: num(args, 'y'),
        });
        return result;
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'browser_type',
          description:
            'Type text into an element on the active/named tab by selector or inspect index. ' +
            'Set consequential=true if it submits a form, sends a message, or deletes data.',
          parameters: {
            type: 'object',
            properties: {
              tab_id: { type: 'string' },
              selector: { type: 'string' },
              index: { type: 'number' },
              text: { type: 'string', description: 'The text to type.' },
              consequential: { type: 'boolean' },
            },
            required: ['text'],
            additionalProperties: false,
          },
        },
      },
      permission: 'browser',
      autoApprove: true,
      approval: ctx.inputApproval('browser_type'),
      handler: async (args) => {
        const text = typeof args.text === 'string' ? args.text : '';
        ctx.markTargetOrigin(args);
        const result = await ctx.mgr.type(
          ctx.str(args, 'tab_id'),
          { selector: ctx.str(args, 'selector'), index: num(args, 'index') },
          text,
        );
        return result;
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'browser_press',
          description:
            'Press a key (e.g. "Enter", "Tab", "a", "Control+A") on the active/named tab, ' +
            'optionally scoped to a selector. Set consequential=true if it submits a form or ' +
            'sends a message.',
          parameters: {
            type: 'object',
            properties: {
              tab_id: { type: 'string' },
              key: { type: 'string', description: 'Key or chord to press.' },
              selector: { type: 'string' },
              consequential: { type: 'boolean' },
            },
            required: ['key'],
            additionalProperties: false,
          },
        },
      },
      permission: 'browser',
      autoApprove: true,
      approval: ctx.inputApproval('browser_press'),
      handler: async (args) => {
        const key = ctx.str(args, 'key');
        if (!key) throw new Error('browser_press: key is required');
        ctx.markTargetOrigin(args);
        const result = await ctx.mgr.press(ctx.str(args, 'tab_id'), key, ctx.str(args, 'selector'));
        return result;
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'browser_scroll',
          description:
            'Scroll the active/named tab by (delta_x, delta_y) at a viewport point, or scroll ' +
            'a specific selector.',
          parameters: {
            type: 'object',
            properties: {
              tab_id: { type: 'string' },
              selector: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
              delta_x: { type: 'number' },
              delta_y: { type: 'number' },
            },
            additionalProperties: false,
          },
        },
      },
      permission: 'browser',
      autoApprove: true,
      handler: async (args) => {
        const result = await ctx.mgr.scroll(
          ctx.str(args, 'tab_id'),
          { selector: ctx.str(args, 'selector'), x: num(args, 'x'), y: num(args, 'y') },
          num(args, 'delta_x') ?? 0,
          num(args, 'delta_y') ?? 0,
        );
        return result;
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'browser_hover',
          description:
            'Hover over an element on the active/named tab by selector, inspect index, or ' +
            'viewport x,y.',
          parameters: {
            type: 'object',
            properties: {
              tab_id: { type: 'string' },
              selector: { type: 'string' },
              index: { type: 'number' },
              x: { type: 'number' },
              y: { type: 'number' },
            },
            additionalProperties: false,
          },
        },
      },
      permission: 'browser',
      autoApprove: true,
      handler: async (args) => {
        const result = await ctx.mgr.hover(ctx.str(args, 'tab_id'), {
          selector: ctx.str(args, 'selector'),
          index: num(args, 'index'),
          x: num(args, 'x'),
          y: num(args, 'y'),
        });
        return result;
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'browser_drag',
          description:
            'Drag from (from_x, from_y) to (to_x, to_y) in viewport pixels on the active/named tab.',
          parameters: {
            type: 'object',
            properties: {
              tab_id: { type: 'string' },
              from_x: { type: 'number' },
              from_y: { type: 'number' },
              to_x: { type: 'number' },
              to_y: { type: 'number' },
            },
            required: ['from_x', 'from_y', 'to_x', 'to_y'],
            additionalProperties: false,
          },
        },
      },
      permission: 'browser',
      autoApprove: true,
      handler: async (args) => {
        const req = (k: string): number => {
          const v = args[k];
          if (typeof v !== 'number') throw new Error(`browser_drag: ${k} is required`);
          return v;
        };
        const result = await ctx.mgr.drag(
          ctx.str(args, 'tab_id'),
          { x: req('from_x'), y: req('from_y') },
          { x: req('to_x'), y: req('to_y') },
        );
        return result;
      },
    },
  ];
}
