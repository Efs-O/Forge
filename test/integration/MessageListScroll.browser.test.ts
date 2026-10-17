import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function missingEdge(error: unknown): boolean {
  return /browserType\.launch|Executable doesn't exist|please run.*install|channel .*not found|msedge could not be launched/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

describe('MessageList scroll behavior in Edge', () => {
  it('follows real content reflow, honors wheel-up, then resumes at the bottom', async (ctx) => {
    let browser: Browser;
    const browserTempRoot = path.join(ROOT, 'node_modules/.cache');
    await mkdir(browserTempRoot, { recursive: true });
    const browserTemp = await mkdtemp(path.join(browserTempRoot, 'forge-edge-'));
    try {
      browser = await chromium.launch({
        channel: 'msedge',
        headless: true,
        env: { ...process.env, TEMP: browserTemp, TMP: browserTemp, TMPDIR: browserTemp },
      });
    } catch (error) {
      await rm(browserTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (missingEdge(error)) {
        ctx.skip(`Edge is unavailable on this host: ${String(error)}`);
        return;
      }
      throw error;
    }

    try {
      const bundle = await esbuild.build({
        entryPoints: [path.join(ROOT, 'test/support/MessageListBrowserFixture.tsx')],
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: 'es2022',
        jsx: 'automatic',
        jsxImportSource: 'react',
      });
      const styles = await Promise.all(
        ['base.css', 'layout.css', 'messages.css'].map((name) =>
          readFile(path.join(ROOT, 'webview-ui/styles', name), 'utf8'),
        ),
      );
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      page.setDefaultTimeout(5000);
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.setContent(`<style>${styles.join('\n')}</style><div id="root"></div>`);
      await page.evaluate(() => {
        (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
          postMessage: () => undefined,
        });
      });
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text });

      const pane = page.locator('.messages-pane');
      try {
        await pane.waitFor();
      } catch (error) {
        throw new Error(`MessageList did not render: ${pageErrors.join('; ')}`, { cause: error });
      }
      const atBottom = () =>
        page.waitForFunction(() => {
          const el = document.querySelector<HTMLElement>('.messages-pane');
          return Boolean(el && el.scrollHeight - el.scrollTop - el.clientHeight <= 1);
        }, undefined, { timeout: 5000 });
      const longReply = `Streaming content reflows the transcript. ${'More text grows this answer. '.repeat(180)}`;

      await atBottom();
      await page.evaluate(
        (content) => window.setTranscriptMessage('history-99', content),
        longReply,
      );
      await atBottom();

      await page.mouse.move(600, 400);
      await page.mouse.wheel(0, -500);
      await page.waitForFunction(() => {
        const el = document.querySelector<HTMLElement>('.messages-pane');
        return Boolean(el && el.scrollTop < el.scrollHeight - el.clientHeight - 100);
      }, undefined, { timeout: 5000 });
      const readerPosition = await pane.evaluate((el) => el.scrollTop);
      const previousHeight = await pane.evaluate((el) => el.scrollHeight);
      await page.evaluate(
        (content) =>
          window.setTranscriptMessage(
            'history-99',
            `${content} ${'Additional streamed line. '.repeat(80)}`,
          ),
        longReply,
      );
      await page.waitForFunction(
        (previousHeight) => {
          const el = document.querySelector<HTMLElement>('.messages-pane');
          return Boolean(el && el.scrollHeight > previousHeight);
        },
        previousHeight,
        { timeout: 5000 },
      );
      const afterGrowth = await pane.evaluate((el) => ({
        scrollTop: el.scrollTop,
        distance: el.scrollHeight - el.scrollTop - el.clientHeight,
      }));
      expect(afterGrowth.distance).toBeGreaterThan(100);
      expect(Math.abs(afterGrowth.scrollTop - readerPosition)).toBeLessThan(100);

      await page.mouse.wheel(0, 10000);
      await atBottom();
      await page.evaluate(
        (content) =>
          window.setTranscriptMessage('history-99', `${content} ${'Follow resumed. '.repeat(40)}`),
        longReply,
      );
      await atBottom();
      await page.close();
    } finally {
      await browser.close();
      await rm(browserTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30000);
});
