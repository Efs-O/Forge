import type { BrowserChannel } from '../browser/BrowserSessionManager';
import { pngDimensions } from '../browser/BrowserSessionManager';
import type { ToolHandlerContext, ToolHandlerResult } from '../ToolRegistry';
import { readHtmlFile, readViewportPx } from './htmlInput';
import { renderPreview } from './renderEngine';

/**
 * `render_html_to_image` with `mode: "preview"`: let the agent look at a page
 * it wrote before calling it done. Unlike image mode it saves nothing, sends
 * nothing to a remote chat and spends no file budget — the result goes to the
 * model only (RENDER_PREVIEW_PLAN.md; its ledger test pins that).
 */

export const DEFAULT_PREVIEW_WAIT_MS = 3_000;
export const MAX_PREVIEW_WAIT_MS = 15_000;

export interface PreviewOptions {
  channel: BrowserChannel;
  /** Launch + load + screenshot budget; the settle wait is added on top. */
  baseTimeoutMs: number;
  now: () => number;
}

export async function runPreview(
  args: Record<string, unknown>,
  context: ToolHandlerContext | undefined,
  options: PreviewOptions,
): Promise<ToolHandlerResult> {
  const rawPath = args['path'];
  // The preview must show the file on disk, not a re-typed copy of it: a copy
  // can differ from what the user will open, and checking it proves nothing.
  if (typeof args['html'] === 'string' && args['html'].trim() !== '') {
    throw new Error(
      'render_html_to_image: preview mode takes path, not html — write the page to a workspace file and pass its path.',
    );
  }
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new Error('render_html_to_image: preview mode requires path (a workspace .html file).');
  }
  if (args['full_page'] !== undefined) {
    throw new Error(
      'render_html_to_image: full_page applies to image mode only; preview captures the viewport.',
    );
  }
  const width = readViewportPx(args['width'], 1024, 'width');
  const height = readViewportPx(args['height'], 1024, 'height');
  const waitMs = readWaitMs(args['wait_ms']);
  const html = await readHtmlFile(rawPath);

  const started = options.now();
  const result = await renderPreview(
    {
      html,
      width,
      height,
      channel: options.channel,
      timeoutMs: options.baseTimeoutMs + waitMs,
      settleMs: waitMs,
    },
    context?.abortSignal,
  );
  const elapsedS = ((options.now() - started) / 1000).toFixed(1);
  const dims = pngDimensions(result.png);

  const lines = [
    `Preview of ${rawPath} at ${dims.width}x${dims.height}, screenshot taken ${waitMs} ms after load (${elapsedS} s total). Nothing was saved or sent.`,
  ];
  if (result.errorCount === 0) {
    lines.push('Page errors: none.');
  } else {
    const more = result.errorCount - result.errors.length;
    lines.push(`Page errors (${result.errorCount}):`, ...result.errors.map((e) => `- ${e}`));
    if (more > 0) lines.push(`- … ${more} more not shown`);
  }
  if (result.blocked.length > 0) {
    lines.push(
      `Blocked requests (preview allows only https GETs to cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com; relative and local assets do not load): ${result.blocked.join(', ')}`,
    );
  }
  if (!context?.isVisionModel) {
    lines.push(
      'No screenshot attached: the active model has no vision input. Only the error list above is available.',
    );
    return lines.join('\n');
  }
  lines.push('Screenshot attached.');
  const text = lines.join('\n');
  return {
    text,
    content: [
      { type: 'text', text },
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${result.png.toString('base64')}` },
      },
    ],
  };
}

function readWaitMs(value: unknown): number {
  if (value === undefined) return DEFAULT_PREVIEW_WAIT_MS;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('render_html_to_image: wait_ms must be an integer.');
  }
  if (value < 0 || value > MAX_PREVIEW_WAIT_MS) {
    throw new Error(
      `render_html_to_image: wait_ms is ${value}; the range is 0–${MAX_PREVIEW_WAIT_MS}.`,
    );
  }
  return value;
}
