import * as fs from 'fs/promises';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import { printHtmlToPdf } from '../../src/documents/pdfExport';
import { renderPdfPages } from '../../src/documents/pdfRenderer';
import { useRealProfileForBrowser } from '../support/realHome';

// Chrome hangs on Windows under the throwaway home the temp guard sets; see the helper.
useRealProfileForBrowser();

const configFor = (channel: 'chrome' | 'msedge'): ForgeConfig =>
  ({ browser: { channel, headless: true } }) as ForgeConfig;
const missingBrowser = (error: unknown): boolean =>
  /Executable doesn't exist|channel .*not found|browserType\.launch|chrome could not be launched|msedge could not be launched/i.test(
    error instanceof Error ? error.message : String(error),
  );

type BrowserAttempt<T> = { value: T } | { missing: unknown };

async function withSystemBrowser<T>(
  operation: (channel: 'chrome' | 'msedge') => Promise<T>,
): Promise<BrowserAttempt<T>> {
  let lastMissing: unknown;
  for (const channel of ['chrome', 'msedge'] as const) {
    try {
      return { value: await operation(channel) };
    } catch (error) {
      if (!missingBrowser(error)) throw error;
      lastMissing = error;
    }
  }
  return { missing: lastMissing };
}

function skipWithoutSystemBrowser(
  ctx: { skip: (message: string) => never },
  attempt: { missing: unknown },
): never {
  return ctx.skip(`no system Chrome or Edge channel: ${String(attempt.missing)}`);
}

describe('document PDF browser paths against a system browser', () => {
  // Both tests launch a real Chrome or Edge and render through it. That costs
  // seconds on a warm machine and minutes when the runner is loaded, so neither
  // runs on the 5 s default: the macOS runner timed the first one out. The
  // assertions are the same; only the ceiling around them moved.
  const SYSTEM_BROWSER_TIMEOUT_MS = 60_000;

  it(
    'renders a PDF page to PNG',
    async (ctx) => {
      const pdf = await fs.readFile(path.resolve('test/fixtures/documents/sample.pdf'));
      const attempt = await withSystemBrowser((channel) =>
        renderPdfPages(pdf, [1], () => configFor(channel), new AbortController().signal),
      );
      if ('missing' in attempt) skipWithoutSystemBrowser(ctx, attempt);
      const page = attempt.value[0];
      expect(page.png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(page.width).toBeGreaterThan(0);
      expect(page.height).toBeGreaterThan(0);
    },
    SYSTEM_BROWSER_TIMEOUT_MS,
  );

  it(
    'exports Markdown HTML to PDF',
    async (ctx) => {
      const attempt = await withSystemBrowser((channel) =>
        printHtmlToPdf(
          '<!doctype html><html><body><p>tiny Markdown export</p></body></html>',
          () => configFor(channel),
          new AbortController().signal,
        ),
      );
      if ('missing' in attempt) skipWithoutSystemBrowser(ctx, attempt);
      expect(attempt.value.toString('ascii', 0, 4)).toBe('%PDF');
    },
    SYSTEM_BROWSER_TIMEOUT_MS,
  );
});
