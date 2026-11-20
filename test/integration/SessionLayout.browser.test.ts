import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import { launchSeededBrowser, type SeededBrowser } from '../../src/tools/browser/seededBrowser';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function missingEdge(error: unknown): boolean {
  return /browserType\.launch|Executable doesn't exist|please run.*install|channel .*not found|msedge could not be launched/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

describe('session layout rendering in Edge', () => {
  it('keeps the compact header, aligned rows and theme-token contrast at narrow and wide widths', async (ctx) => {
    const cache = path.join(ROOT, 'node_modules/.cache');
    await mkdir(cache, { recursive: true });
    const temp = await mkdtemp(path.join(cache, 'forge-session-layout-'));
    let session: SeededBrowser;
    try {
      session = await launchSeededBrowser({
        channel: 'msedge',
        headless: true,
        env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp },
        context: { viewport: { width: 900, height: 800 } },
      });
    } catch (error) {
      await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (missingEdge(error)) {
        ctx.skip(`Edge is unavailable on this host: ${String(error)}`);
        return;
      }
      throw error;
    }

    try {
      const bundle = await esbuild.build({
        entryPoints: [path.join(ROOT, 'test/support/SessionLayoutBrowserFixture.tsx')],
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: 'es2022',
        jsx: 'automatic',
        jsxImportSource: 'react',
      });
      const styles = await Promise.all(
        ['base.css', 'layout.css', 'chat-header.css', 'sessions-panel.css', 'history-rows.css'].map(
          (name) => readFile(path.join(ROOT, 'webview-ui/styles', name), 'utf8'),
        ),
      );
      const page = await session.context.newPage();
      page.setDefaultTimeout(5000);
      page.on('pageerror', (error) => {
        throw new Error(`session layout fixture failed: ${error.message}`);
      });
      await page.setContent(
        `<style>${styles.join('\n')}\n` +
          `:root { --vscode-sideBar-background:#202020; --vscode-foreground:#f0f0f0; ` +
          `--vscode-descriptionForeground:#a0a0a0; --vscode-badge-background:#555; ` +
          `--vscode-badge-foreground:#fff; --vscode-testing-iconPassed:#73c991; ` +
          `--vscode-charts-green:#73c991; --vscode-errorForeground:#f48771; ` +
          `--vscode-charts-orange:#cd9178; ` +
          `--vscode-editorWidget-background:#252526; --vscode-widget-border:#444; }` +
          `body { margin:0; width:100vw; overflow-x:hidden; }` +
          `</style><div id="root"></div>`,
      );
      await page.evaluate(() => {
        (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
          postMessage: () => undefined,
          getState: () => undefined,
          setState: () => undefined,
        });
      });
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
      await page.locator('#history-open-list .history-item-title').first().waitFor();

      const wide = await page.evaluate(() => {
        const box = (selector: string) => {
          const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          };
        };
        const titles = Array.from(
          document.querySelectorAll<HTMLElement>('#history-open-list .history-item-title'),
        );
        const groups = Array.from(document.querySelectorAll<HTMLElement>('.agent-link-group'));
        return {
          icon: box('#forge-mark'),
          wordmarkSize: getComputedStyle(document.querySelector('#forge-wordmark')!).fontSize,
          titleSize: getComputedStyle(document.querySelector('#chat-header-title')!).fontSize,
          tabBottom: box('.history-tablist').bottom,
          firstRowTop: box('#history-open-list .history-item-row').top,
          titleLefts: titles.map((title) => title.getBoundingClientRect().left),
          groupBoxes: groups.map((group) => {
            const rect = group.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
          }),
          toolbar: box('#chats-toolbar-actions'),
          title: box('#chat-header-title'),
        };
      });
      expect(wide.icon.width).toBe(24);
      expect(wide.icon.height).toBe(24);
      expect(wide.wordmarkSize).toBe('16px');
      expect(wide.titleSize).toBe('14px');
      expect(wide.firstRowTop - wide.tabBottom).toBeGreaterThanOrEqual(8);
      expect(wide.firstRowTop - wide.tabBottom).toBeLessThanOrEqual(14);
      expect(wide.titleLefts[0]).toBe(wide.titleLefts[1]);
      expect(wide.groupBoxes).toHaveLength(2);
      expect(wide.groupBoxes[0]!.right).toBeLessThanOrEqual(wide.groupBoxes[1]!.left);
      expect(
        wide.groupBoxes.every(
          (group) => group.left >= wide.title.right || group.top >= wide.title.bottom,
        ),
      ).toBe(true);
      expect(
        wide.groupBoxes.every(
          (group) => group.right <= wide.toolbar.left || group.top >= wide.toolbar.bottom,
        ),
      ).toBe(true);
      await page.locator('#history-tab-archived').click();
      const archivedTitleLefts = await page
        .locator('#history-list .history-item-title')
        .evaluateAll((titles) => titles.map((title) => title.getBoundingClientRect().left));
      expect(archivedTitleLefts).toHaveLength(2);
      expect(archivedTitleLefts[0]).toBe(archivedTitleLefts[1]);
      await page.locator('#history-tab-chats').click();

      for (const width of [420, 320]) {
        await page.setViewportSize({ width, height: 800 });
        await page.waitForFunction(
          (targetWidth) => document.documentElement.scrollWidth <= targetWidth,
          width,
          { timeout: 2000 },
        );
        const narrow = await page.evaluate(() => ({
          viewportWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          panelWidth: document.querySelector<HTMLElement>('#history-panel')!.getBoundingClientRect()
            .width,
          titleLefts: Array.from(
            document.querySelectorAll<HTMLElement>('#history-open-list .history-item-title'),
          ).map((title) => title.getBoundingClientRect().left),
          title: document
            .querySelector<HTMLElement>('#chat-header-title')!
            .getBoundingClientRect()
            .toJSON(),
          groups: Array.from(document.querySelectorAll<HTMLElement>('.agent-link-group')).map(
            (group) => group.getBoundingClientRect().toJSON(),
          ),
          toolbar: document
            .querySelector<HTMLElement>('#chats-toolbar-actions')!
            .getBoundingClientRect()
            .toJSON(),
        }));
        expect(narrow.viewportWidth).toBe(width);
        expect(narrow.scrollWidth).toBeLessThanOrEqual(width);
        expect(narrow.panelWidth).toBeLessThanOrEqual(width);
        expect(narrow.titleLefts[0]).toBe(narrow.titleLefts[1]);
        for (const group of narrow.groups) {
          const separated =
            group.right <= narrow.title.left ||
            group.left >= narrow.title.right ||
            group.bottom <= narrow.title.top ||
            group.top >= narrow.title.bottom;
          const clearOfToolbar =
            group.right <= narrow.toolbar.left ||
            group.left >= narrow.toolbar.right ||
            group.bottom <= narrow.toolbar.top ||
            group.top >= narrow.toolbar.bottom;
          expect(separated && clearOfToolbar).toBe(true);
        }
      }

      for (const theme of ['dark', 'light'] as const) {
        await page.evaluate((value) => window.setSessionLayoutTheme(value), theme);
        const colors = await page.evaluate(() => ({
          wordmark: getComputedStyle(document.querySelector('#forge-wordmark')!).color,
          mark: getComputedStyle(document.querySelector('#forge-mark')!).backgroundColor,
          title: getComputedStyle(document.querySelector('#chat-header-title')!).color,
          chats: getComputedStyle(document.querySelector('.history-tab-count--chats')!).color,
          archived: getComputedStyle(document.querySelector('.history-tab-count--archived')!).color,
        }));
        expect(colors.wordmark).not.toBe(colors.title);
        expect(colors.mark).toBe('rgb(205, 145, 120)');
        expect(colors.chats).not.toBe(colors.archived);
        expect(colors.wordmark).not.toBe('');
        await page.screenshot({ path: path.join(cache, `forge-session-layout-${theme}-320.png`) });
      }
      await page.emulateMedia({ forcedColors: 'active' });
      await page.locator('.history-item-close').first().focus();
      await page.screenshot({ path: path.join(cache, 'forge-session-layout-320.png') });
      const forced = await page.evaluate(() => ({
        title: document.querySelector<HTMLElement>('#chat-header-title')!.getBoundingClientRect()
          .width,
        tabs: document.querySelectorAll('.history-tab').length,
        closeVisibility: getComputedStyle(document.querySelector('.history-item-close')!)
          .visibility,
      }));
      expect(forced.title).toBeGreaterThan(0);
      expect(forced.tabs).toBe(3);
      expect(forced.closeVisibility).not.toBe('hidden');

      await page.emulateMedia({ forcedColors: 'none' });
      await page.setViewportSize({ width: 1400, height: 800 });
      await page.evaluate(() => {
        document.body.style.zoom = '1.5';
        document.body.style.width = 'calc(100vw / 1.5)';
      });
      const row = page.locator('#history-open-list .history-item-row').first();
      const status = row.locator('.history-item-meta');
      expect(await status.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect((await row.boundingBox())!.height).toBeLessThanOrEqual(45);
      await page.screenshot({ path: path.join(cache, 'forge-session-layout-corrected-150.png') });

      // Use real browser clicks, including controls without hover and the menu
      // on the last visible row. No-op render callbacks hid these regressions.
      await row.locator('.history-item-keep-open').click();
      expect(await row.locator('.history-item-keep-open').getAttribute('aria-pressed')).toBe(
        'false',
      );
      await row.locator('.history-item').click();
      await page.locator('#history-open-list .history-item-close').last().click();
      expect(await page.locator('#history-open-list .history-item-row').count()).toBe(1);
      await page.locator('#history-tab-archived').click();
      const archivedRow = page.locator('#history-list .history-item-row').last();
      await archivedRow.locator('.history-item-kebab').click();
      const menu = page.getByRole('menu');
      expect((await menu.boundingBox())!.y).toBeGreaterThanOrEqual(0);
      await menu.getByRole('menuitem', { name: 'Rename' }).click();
      await page.locator('.history-rename-input').fill('Renamed chat');
      await page.locator('.history-rename-input').press('Enter');
      await archivedRow.locator('.history-item-kebab').click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      await archivedRow.locator('.history-item').click();
      await page.locator('#history-tab-jobs').click();
      await page.locator('#history-jobs-list .history-item').click();
      await page.locator('#history-toolbar-btn').click();
      expect(await page.locator('#history-panel').isVisible()).toBe(false);
      await page.getByRole('button', { name: 'Unlink Codex', exact: true }).click();
      await page.locator('#tab-new-btn').click();
      expect(await page.locator('#chat-header-title').textContent()).toBe('Untitled chat');
      const actions = await page.evaluate(() => window.sessionLayoutActions);
      expect(actions).toEqual(
        expect.arrayContaining([
          'pin:open-codex:false',
          'switch:open-codex',
          'close:open-you',
          'rename:closed-open-you:Renamed chat',
          'delete:closed-open-you',
          'restore:closed-open-you',
          'unlink:codex',
          'job:job-check',
          'new',
        ]),
      );
    } finally {
      await session.close();
      await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30000);
});
