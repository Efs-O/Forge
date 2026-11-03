import * as fs from 'fs/promises';
import * as path from 'path';
import { DEFAULT_BROWSER_CHANNEL } from '../config/browserSchema';
import type { ForgeConfig } from '../config/types';
import { HARDENED_LAUNCH_ARGS, withRenderBrowser } from '../tools/renderHtml/renderBrowser';
import { pngDimensions } from '../tools/browser/BrowserSessionManager';

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_RENDERED_EDGE = 4096;
const MAX_RENDERED_PIXELS = 16_000_000;
const MAX_RENDERED_PNG_BYTES = 10 * 1024 * 1024;

export interface RenderedPdfPage {
  page: number;
  png: Buffer;
  width: number;
  height: number;
}

async function pdfJsFiles(): Promise<{ main: string; worker: string }> {
  const bundledMain = path.resolve(__dirname, 'pdfjs', 'pdf.mjs');
  let main: string;
  try {
    await fs.access(bundledMain);
    main = bundledMain;
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw error;
    main = path.resolve(__dirname, '../../node_modules/pdfjs-dist/build/pdf.mjs');
  }
  return { main, worker: path.join(path.dirname(main), 'pdf.worker.mjs') };
}

export async function renderPdfPages(
  bytes: Buffer,
  pageNumbers: readonly number[],
  getConfig: (() => ForgeConfig) | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<RenderedPdfPage[]> {
  if (bytes.length > MAX_PDF_BYTES)
    throw new Error(`view_image: PDF exceeds its ${MAX_PDF_BYTES / 1024 / 1024} MiB limit.`);
  if (!pageNumbers.length || pageNumbers.length > 4)
    throw new Error('view_image: request 1-4 PDF pages.');
  const files = await pdfJsFiles();
  const [mainSource, workerSource] = await Promise.all([
    fs.readFile(files.main),
    fs.readFile(files.worker),
  ]);
  if (abortSignal?.aborted) throw new Error('view_image: PDF rendering cancelled.');
  const request = {
    channel: getConfig?.().browser?.channel ?? DEFAULT_BROWSER_CHANNEL,
    timeoutMs: 30_000,
    args: HARDENED_LAUNCH_ARGS,
  };
  return withRenderBrowser(request, abortSignal, async (browser) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
    });
    await context.route('**/*', (route) => void route.abort());
    try {
      const page = await context.newPage();
      await page.setContent('<!doctype html><html><body></body></html>', { waitUntil: 'load' });
      return await page
        .evaluate(
          async ({ pdfData, mainData, workerData, requested, maxEdge, maxPixels }) => {
            const decode = (value: string): Uint8Array => {
              const raw = atob(value);
              const bytes = new Uint8Array(raw.length);
              for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
              return bytes;
            };
            const dom = globalThis as unknown as {
              document: {
                createElement: (tag: 'canvas') => {
                  width: number;
                  height: number;
                  getContext: (kind: '2d') => object | null;
                  toDataURL: (type: 'image/png') => string;
                };
              };
            };
            const blobUrl = (source: string): string =>
              URL.createObjectURL(new Blob([decode(source)], { type: 'text/javascript' }));
            const moduleUrl = blobUrl(mainData);
            const workerUrl = blobUrl(workerData);
            try {
              const pdfjs = (await Function('url', 'return import(url)')(moduleUrl)) as {
                GlobalWorkerOptions: { workerSrc: string };
                getDocument: (options: Record<string, unknown>) => {
                  promise: Promise<{
                    numPages: number;
                    getPage: (page: number) => Promise<{
                      getViewport: (options: { scale: number }) => {
                        width: number;
                        height: number;
                      };
                      render: (options: {
                        canvasContext: object;
                        viewport: { width: number; height: number };
                      }) => { promise: Promise<void> };
                    }>;
                    destroy: () => Promise<void>;
                  }>;
                };
              };
              pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
              const document = await pdfjs.getDocument({
                data: decode(pdfData),
                isEvalSupported: false,
                useWorkerFetch: false,
              }).promise;
              try {
                const pages: Array<{ page: number; png: string; width: number; height: number }> =
                  [];
                for (const number of requested) {
                  if (number < 1 || number > document.numPages)
                    throw new Error(`page ${number} is outside 1-${document.numPages}`);
                  const pdfPage = await document.getPage(number);
                  const base = pdfPage.getViewport({ scale: 1 });
                  const scale = Math.min(
                    2,
                    maxEdge / Math.max(base.width, base.height),
                    Math.sqrt(maxPixels / (base.width * base.height)),
                  );
                  const viewport = pdfPage.getViewport({ scale });
                  const canvas = dom.document.createElement('canvas');
                  canvas.width = Math.ceil(viewport.width);
                  canvas.height = Math.ceil(viewport.height);
                  await pdfPage.render({ canvasContext: canvas.getContext('2d')!, viewport })
                    .promise;
                  const dataUrl = canvas.toDataURL('image/png');
                  pages.push({
                    page: number,
                    png: dataUrl.slice('data:image/png;base64,'.length),
                    width: canvas.width,
                    height: canvas.height,
                  });
                  canvas.width = 0;
                  canvas.height = 0;
                }
                return pages;
              } finally {
                await document.destroy();
              }
            } finally {
              URL.revokeObjectURL(moduleUrl);
              URL.revokeObjectURL(workerUrl);
            }
          },
          {
            pdfData: bytes.toString('base64'),
            mainData: mainSource.toString('base64'),
            workerData: workerSource.toString('base64'),
            requested: [...pageNumbers],
            maxEdge: MAX_RENDERED_EDGE,
            maxPixels: MAX_RENDERED_PIXELS,
          },
        )
        .then((pages) =>
          pages.map(({ page, png, width, height }) => {
            const buffer = Buffer.from(png, 'base64');
            if (buffer.length > MAX_RENDERED_PNG_BYTES)
              throw new Error(
                `view_image: rendered PDF page ${page} is over the 10 MiB PNG limit.`,
              );
            const dimensions = pngDimensions(buffer);
            if (dimensions.width !== width || dimensions.height !== height)
              throw new Error(`view_image: PDF page ${page} rendered an invalid PNG.`);
            return { page, png: buffer, width, height };
          }),
        );
    } finally {
      await context.close().catch(() => undefined);
    }
  });
}
