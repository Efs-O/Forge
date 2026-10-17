import type { BrowserChannel } from '../browser/BrowserSessionManager';
import { pngDimensions } from '../browser/BrowserSessionManager';
import type { ToolHandlerContext, ToolHandlerResult } from '../ToolRegistry';
import { readHtmlFile, readViewportPx } from './htmlInput';
import { renderPreview } from './previewRenderer';

/**
 * `render_html_to_image` with `mode: "preview"`: let the agent look at a page
 * it wrote before calling it done. Unlike image mode it saves nothing, sends
 * nothing to a remote chat and spends no file budget — the result goes to the
 * model only (RENDER_PREVIEW_PLAN.md; its ledger test pins that).
 */

export const DEFAULT_PREVIEW_WAIT_MS = 3_000;
export const MAX_PREVIEW_WAIT_MS = 30_000;
export const PREVIEW_KEY_NAMES = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `Key${letter}`),
  ...'0123456789'.split('').map((digit) => `Digit${digit}`),
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'Enter',
  'Escape',
  'Shift',
  'Control',
  'Alt',
  'Tab',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  ' ',
] as const;

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
  const frames = readFrames(args['frames'], args['wait_ms']);
  const keys = readKeys(args['keys']);
  const waitMs = frames.at(-1) ?? DEFAULT_PREVIEW_WAIT_MS;
  const html = await readHtmlFile(rawPath);

  const started = options.now();
  const result = await renderPreview(
    {
      html,
      width,
      height,
      channel: options.channel,
      timeoutMs: options.baseTimeoutMs + waitMs + keys.reduce((sum, k) => sum + k.holdMs, 0),
      frames,
      keys,
    },
    context?.abortSignal,
  );
  const elapsedS = ((options.now() - started) / 1000).toFixed(1);
  const dims = pngDimensions(result.frames[0]!.png);

  const lines = [
    `Preview of ${rawPath} at ${dims.width}x${dims.height}, ${result.frames.length} frame(s) captured (${elapsedS} s total). Nothing was saved or sent.`,
  ];
  if (args['frames'] !== undefined && args['wait_ms'] !== undefined) {
    lines.push('wait_ms ignored: frames sets the capture times.');
  }
  if (result.errorCount === 0) {
    lines.push('Page errors: none.');
  } else {
    lines.push(`Page errors (${result.errorCount}):`, ...result.errors.map((e) => `- ${e}`));
    if (result.suppressedErrorCount > 0) {
      lines.push(`- … ${result.suppressedErrorCount} more error event(s) not shown`);
    }
  }
  if (result.blocked.length > 0) {
    lines.push(`Requests that did not load: ${result.blocked.join('; ')}`);
  }
  lines.push(
    `Console output (${result.consoleLines.length} lines, capped at 4000 characters):`,
    ...(result.consoleLines.length ? result.consoleLines.map((line) => `- ${line}`) : ['- none']),
  );
  if (result.consoleDropped > 0)
    lines.push(`- … ${result.consoleDropped} older console lines dropped`);
  if (!context?.isVisionModel) {
    lines.push(
      'No screenshot attached: the active model has no vision input. Only the text above is available.',
    );
    return lines.join('\n');
  }
  lines.push('Frames attached:');
  for (const frame of result.frames) lines.push(`- ${frame.timeMs} ms`);
  const text = lines.join('\n');
  return {
    text,
    content: [
      { type: 'text', text },
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${result.frames[0]!.png.toString('base64')}` },
      },
      ...result.frames.slice(1).map((frame) => ({
        type: 'image_url' as const,
        image_url: { url: `data:image/png;base64,${frame.png.toString('base64')}` },
      })),
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

function readFrames(value: unknown, waitMs: unknown): number[] {
  if (value === undefined) return [readWaitMs(waitMs)];
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new Error('render_html_to_image: frames must contain 1–4 capture times.');
  }
  let previous = -1;
  return value.map((time, index) => {
    if (typeof time !== 'number' || !Number.isInteger(time)) {
      throw new Error(`render_html_to_image: frames[${index}] must be an integer.`);
    }
    if (time < 0 || time > MAX_PREVIEW_WAIT_MS) {
      throw new Error(
        `render_html_to_image: frames[${index}] is ${time}; the range is 0–${MAX_PREVIEW_WAIT_MS}.`,
      );
    }
    if (time <= previous)
      throw new Error('render_html_to_image: frames must be strictly ascending.');
    previous = time;
    return time;
  });
}

function readKeys(value: unknown): Array<{ key: string; holdMs: number }> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error('render_html_to_image: keys must contain at most 8 key actions.');
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`render_html_to_image: keys[${index}] must contain key and hold_ms.`);
    }
    const item = entry as Record<string, unknown>;
    const key = item['key'];
    const holdMs = item['hold_ms'];
    if (typeof key !== 'string' || !(PREVIEW_KEY_NAMES as readonly string[]).includes(key)) {
      throw new Error(
        `render_html_to_image: keys[${index}].key must be A–Z, a–z, 0–9, KeyA–KeyZ, Digit0–Digit9, ` +
          'ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Backspace, Delete, Home, End, PageUp, PageDown, ' +
          'Space, Enter, Escape, Shift, Control, Alt, Tab, or a space character.',
      );
    }
    if (typeof holdMs !== 'number' || !Number.isInteger(holdMs) || holdMs < 0 || holdMs > 3_000) {
      throw new Error(
        `render_html_to_image: keys[${index}].hold_ms must be an integer from 0 to 3000.`,
      );
    }
    // Playwright maps lowercase w to physical code KeyW; accept those code names too.
    const normalizedKey = /^Key[A-Z]$/.test(key)
      ? key.slice(3).toLowerCase()
      : /^Digit\d$/.test(key)
        ? key.slice(5)
        : key;
    return { key: normalizedKey, holdMs };
  });
}
