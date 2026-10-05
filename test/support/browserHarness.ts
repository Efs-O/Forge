/**
 * Shared harness for the browser tool integration tests.
 *
 * Both `test/integration/BrowserTools.test.ts` (inspect, index identity,
 * coordinate bounds, action latency) and
 * `test/integration/BrowserSelectInput.test.ts` (the `<select>` input paths)
 * drive the same real headless Chrome through the same registered tools. The
 * fixtures and helpers live here so the two files have ONE implementation of
 * each — a second copy of `parseInspect` or of a fixture would let them drift
 * into asserting different things about the same contract.
 *
 * Each harness owns its own `BrowserSessionManager`, so each test file gets an
 * isolated browser session; nothing is shared across files.
 *
 * A `data:` URL is used for every fixture so the origin-approval gate never
 * fires (a data: URL has no origin), keeping the loop deterministic.
 */
import type { ForgeConfig } from '../../src/config/types';
import { BrowserSessionManager } from '../../src/tools/browser/BrowserSessionManager';
import { makeBrowserActionTools } from '../../src/tools/browser/browserActionTools';
import {
  buildBrowserToolContext,
  makeBrowserSessionTools,
} from '../../src/tools/browser/browserTools';
import type { MultimodalToolResult, RegisteredTool } from '../../src/tools/ToolRegistry';

/** A button that rewrites the heading, so a click has an observable effect. */
export const PAGE =
  'data:text/html,' +
  encodeURIComponent(
    '<html><body style="font:28px sans-serif;padding:24px">' +
      '<h1 id="h">Before click</h1>' +
      '<button id="btn" onclick="document.getElementById(\'h\').textContent=\'After click\'">Click me</button>' +
      '</body></html>',
  );

/**
 * A fixture page with the shapes that break a naive selector: a duplicate `id`
 * used on three different elements, repeated identical siblings, a nested
 * target, a hidden button, a disabled button, and a text input. Every element
 * records its own click so an action can be attributed to a specific node.
 */
export const RICH_HTML =
  '<html><body style="font:16px sans-serif;padding:16px">' +
  '<h1 id="h">idle</h1>' +
  // Three elements share id="dup": `#dup` is therefore ambiguous and must not be
  // used as an entry's selector.
  '<div id="dup">' +
  '<button data-who="original" onclick="document.getElementById(\'h\').textContent=\'ORIGINAL\'">Dup</button>' +
  '<button id="dup" onclick="document.getElementById(\'h\').textContent=\'SECOND\'">Second dup</button>' +
  '</div>' +
  // Nested target with a genuinely unique id.
  '<section><div><div><button id="nested" title="Nested target" onclick="document.getElementById(\'h\').textContent=\'NESTED\'">Go</button></div></div></section>' +
  '<a id="dup" href="#x">Link dup</a>' +
  '<input id="q" type="text" placeholder="Search">' +
  '<button id="hiddenBtn" style="display:none">Hidden</button>' +
  '<button id="disabledBtn" disabled>Disabled</button>' +
  '<button id="plain" onclick="document.getElementById(\'h\').textContent=\'PLAIN\'">Plain</button>' +
  '<div id="bg" style="width:200px;height:120px;background:#eee" onclick="window.__bg=(window.__bg||0)+1"></div>' +
  '<script>window.__clicks=[];document.addEventListener(\'click\',e=>{window.__clicks.push([e.clientX,e.clientY])});' +
  // A page timer that mutates the DOM without navigating: any index action must
  // survive (or refuse) against a document that is not the one inspected.
  'window.__mutate=()=>{const b=document.querySelector(\'#dup button\');if(b){b.textContent=\'Dup (mutated)\';}};' +
  '</script>' +
  '</body></html>';
export const RICH_PAGE = 'data:text/html,' + encodeURIComponent(RICH_HTML);

export const EMPTY_PAGE = 'data:text/html,' + encodeURIComponent('<html><body><p>Nothing here.</p></body></html>');

/**
 * A dropdown fixture: a single-select whose labels and values DIFFER (so a label
 * match and a value match are distinguishable), and a multi-select.
 */
export const SELECT_PAGE =
  'data:text/html,' +
  encodeURIComponent(
    '<html><body style="font:16px sans-serif;padding:16px">' +
      '<select id="s"><option value="1">One</option><option value="2">Two</option>' +
      '<option value="3">Three</option></select>' +
      '<select id="m" multiple><option value="a">A</option><option value="b">B</option></select>' +
      '</body></html>',
  );

type HandlerCtx = Parameters<RegisteredTool['handler']>[1];

const getConfig = (): ForgeConfig =>
  ({
    active_model: 'primary',
    llama_server: {},
    models: [{ name: 'primary', gguf_path: '/primary.gguf' }],
    browser: { channel: 'chrome', headless: true },
  }) as ForgeConfig;

/** One parsed `browser_inspect` line. */
export interface InspectedEntry {
  index: number;
  role: string;
  text: string;
  selector: string;
}

export interface BrowserHarness {
  mgr: BrowserSessionManager;
  /** Set once a browser has actually been opened; drives the skip guard. */
  opened: boolean;
  skipReason: string;
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
  callText(name: string, args?: Record<string, unknown>): Promise<string>;
  pngFromShot(shot: MultimodalToolResult): Buffer;
  parseInspect(text: string): InspectedEntry[];
  requireBrowser(t: { skip(message?: string): void }): void;
  close(): Promise<void>;
}

/**
 * Build one isolated session with every browser tool registered under its own
 * name, so a test calls the tool exactly as the model would.
 */
export function createBrowserHarness(conversationId: string): BrowserHarness {
  const mgr = new BrowserSessionManager();
  const ctx = buildBrowserToolContext(getConfig, mgr);
  const tools = new Map<string, RegisteredTool>(
    [...makeBrowserSessionTools(ctx), ...makeBrowserActionTools(ctx)].map((t) => [
      t.definition.function.name,
      t,
    ]),
  );
  const toolCtx = { conversationId } as unknown as HandlerCtx;
  const state = { opened: false, skipReason: '' };

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> =>
    tools.get(name)!.handler(args, toolCtx);

  return {
    mgr,
    get opened() {
      return state.opened;
    },
    set opened(value: boolean) {
      state.opened = value;
    },
    get skipReason() {
      return state.skipReason;
    },
    set skipReason(value: string) {
      state.skipReason = value;
    },
    call,
    callText: async (name, args) => (await call(name, args)) as string,
    pngFromShot: (shot) => {
      const img = shot.content!.find((p) => p.type === 'image_url') as { image_url: { url: string } };
      return Buffer.from(img.image_url.url.split('base64,')[1], 'base64');
    },
    parseInspect: (text) =>
      text
        .split('\n')
        .filter((line) => line.startsWith('['))
        .map((line) => {
          // The selector may contain spaces (`html > body:nth-of-type(1) > …`), so it
          // is everything between the em dash and the trailing bbox parenthesis.
          const m = line.match(/^\[(\d+)\]\s+(\S+)\s+"([^"]*)"\s+—\s+(.+?)\s+\([^)]*\)$/);
          if (!m) throw new Error(`unparsable inspect line: ${line}`);
          return { index: Number(m[1]), role: m[2], text: m[3], selector: m[4] };
        }),
    requireBrowser: (t) => {
      if (!state.opened) t.skip(state.skipReason || 'no browser on this host');
    },
    close: () => mgr.close().catch(() => undefined),
  };
}
