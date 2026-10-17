import * as fs from 'fs/promises';
import * as path from 'path';
import { DEFAULT_BROWSER_CHANNEL } from '../config/browserSchema';
import { DEFAULT_IMAGE_OUTPUT_DIR } from '../config/imageGenerationSchema';
import type { ForgeConfig } from '../config/types';
import { writeFileAtomicSync } from '../util/atomicWrite';
import { RENDERED_IMAGE_PREFIX } from '../sidebar/toolResultView';
import type { UserNotificationService } from '../sidebar/UserNotificationService';
import { resolveRealWorkspacePath } from '../util/WorkspacePaths';
import { pngDimensions } from './browser/BrowserSessionManager';
import {
  MAX_VIEWPORT_PX,
  MIN_VIEWPORT_PX,
  checkHtmlBytes,
  readHtmlFile,
  readViewportPx,
} from './renderHtml/htmlInput';
import {
  DEFAULT_PREVIEW_WAIT_MS,
  MAX_PREVIEW_WAIT_MS,
  PREVIEW_KEY_NAMES,
  runPreview,
} from './renderHtml/previewMode';
import { renderPng } from './renderHtml/renderEngine';
import { runShaderCheck } from './renderHtml/shaderCheck';
import type { RegisteredTool, ToolHandlerContext, ToolHandlerResult } from './ToolRegistry';

/** A PNG past this is already enormous; refusing beats shipping it to Telegram. */
const MAX_PNG_BYTES = 10 * 1024 * 1024;
/**
 * Ceiling for a `full_page` capture. Telegram's `sendPhoto` rejects an aspect
 * ratio past 20, and a runaway layout would otherwise produce a PNG Chromium
 * can barely rasterise. Measured on the DOCUMENT before the screenshot (see
 * `measureContentHeight`), so a pathological layout is refused before Chrome
 * spends memory rasterising it; `checkPng` re-checks the PNG as a backstop.
 */
const MAX_FULL_PAGE_HEIGHT_PX = 16_384;
/** Launch + render + screenshot, total. */
const RENDER_TIMEOUT_MS = 30_000;

export interface RenderHtmlDeps {
  /**
   * Optional, matching the registerAllTools call site: the tool is registered
   * unconditionally, so it must work on a signature where the config getter is
   * not supplied. Every read of it is `deps.getConfig?.()` with a documented
   * fallback (`image_generation.output_dir`, `browser.channel`).
   */
  getConfig?: () => ForgeConfig;
  notifications: UserNotificationService;
  /** Injectable for tests; production reads the wall clock. */
  now?: () => Date;
  /**
   * Injectable launch+render+screenshot deadline. Injectable rather than
   * spied on with fake timers because the render path performs real fs I/O,
   * which fake timers deadlock; a short real deadline exercises the same race.
   */
  renderTimeoutMs?: number;
}

export function makeRenderHtmlToImageTool(deps: RenderHtmlDeps): RegisteredTool {
  const tool: RegisteredTool = {
    // Canonical literal: scripts/tool-audit-catalog.mjs extracts it statically.
    definition: {
      type: 'function',
      function: {
        name: 'render_html_to_image',
        description:
          'Render an HTML page. mode "preview": shows you how a page you wrote (canvas, WebGL, ' +
          'three.js, animation, any UI) renders — runs its ' +
          'scripts headless, uses the real GPU (which may briefly slow a local model on the same GPU), ' +
          'and can load libraries from public hosts. It opens nothing for the ' +
          'user: it renders off-screen inside Forge, and only you see the result. ' +
          'console.log from the page is how to read a value out. Returns page errors, console ' +
          'output and screenshots to you only; nothing is saved or sent. ' +
          'mode "image" (default): render an HTML/CSS/SVG page to a PNG and send it to the ' +
          'remote chat watching this turn — for posters, cards, invites, diagrams, infographics; ' +
          'image mode runs no JavaScript and loads nothing external, so inline everything ' +
          '(system fonts, base64 images). Use generate_image for photographs and painterly scenes. ' +
          'mode "shader_check": compile WGSL or GLSL shader text from a workspace file and return ' +
          'the compiler errors; it opens no page and uses no network or GPU.',
        parameters: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['image', 'preview', 'shader_check'],
              description:
                'image (default): save a PNG and send it to the remote chat. preview: screenshot + page errors for you, nothing saved or sent; requires path. shader_check: compile shader text from a workspace file; no workspace page, network, or GPU.',
            },
            html: {
              type: 'string',
              description:
                'Inline HTML — a full document or a fragment. Image mode only. Provide exactly one of html or path.',
            },
            path: {
              type: 'string',
              description:
                'Workspace-relative file to render or check (resolves against the workspace root). shader_check accepts .wgsl, .glsl, .vert, .frag, .js, .mjs, .ts, or .html. Provide exactly one of html or path; preview and shader_check require path. Relative preview assets (./tex.png) do not load.',
            },
            width: {
              type: 'integer',
              description: `Viewport width in CSS px (default 1024). ${MIN_VIEWPORT_PX}–${MAX_VIEWPORT_PX}.`,
            },
            height: {
              type: 'integer',
              description: `Viewport height in CSS px (default 1024). ${MIN_VIEWPORT_PX}–${MAX_VIEWPORT_PX}. Ignored when full_page is true.`,
            },
            full_page: {
              type: 'boolean',
              description:
                'Image mode only. If true, the height is the content height (the poster case) instead of clipping to height. Default false.',
            },
            wait_ms: {
              type: 'integer',
              minimum: 0,
              maximum: MAX_PREVIEW_WAIT_MS,
              description: `Preview only: wait after the page loads before the screenshot, so scripts can draw (default ${DEFAULT_PREVIEW_WAIT_MS}). 0–30000 ms.`,
            },
            frames: {
              type: 'array',
              minItems: 1,
              maxItems: 4,
              items: { type: 'integer', minimum: 0, maximum: MAX_PREVIEW_WAIT_MS },
              description:
                'Preview only: 1–4 strictly ascending capture times in ms, each 0–30000 ms. If wait_ms is also given, frames sets the capture times and the result says wait_ms was ignored.',
            },
            keys: {
              type: 'array',
              maxItems: 8,
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string', enum: [...PREVIEW_KEY_NAMES] },
                  hold_ms: { type: 'integer', minimum: 0, maximum: 3000 },
                },
                required: ['key', 'hold_ms'],
                additionalProperties: false,
              },
              description:
                'Preview only: press these keys in order after load and before the first frame. Before the first key, the first canvas (or focusable element) is focused, as a click would.',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    // Image mode writes a PNG into the workspace AND sends it to
    // api.telegram.org, so a profile with fetch off must not be able to push
    // files out through it. Preview writes nothing, but fetches CDN scripts —
    // fetch-class traffic under the same gate.
    permission: 'fetch',
    additionalPermissions: ['write'],
    // The output path is minted inside the handler (`<timestamp>-<slug>.png`),
    // so a paths() callback would compute a different timestamp and snapshot the
    // wrong file. The handler calls beforeMutate itself — that is the real
    // checkpoint mechanism (same reasoning as generate_image).
    mutation: { paths: () => [], showDiff: false },
    handler: (args, context) => dispatch(deps, args, context),
  };
  return tool;
}

async function dispatch(
  deps: RenderHtmlDeps,
  args: Record<string, unknown>,
  context: ToolHandlerContext | undefined,
): Promise<ToolHandlerResult> {
  const mode = args['mode'] ?? 'image';
  if (mode === 'shader_check') {
    if (typeof args['path'] !== 'string' || args['path'].trim() === '') {
      throw new Error('render_html_to_image: shader_check mode requires path.');
    }
    if (
      ['html', 'wait_ms', 'frames', 'keys', 'full_page', 'width', 'height'].some(
        (key) => args[key] !== undefined,
      )
    ) {
      throw new Error('render_html_to_image: shader_check accepts path only.');
    }
    return runShaderCheck(
      args['path'],
      {
        channel: deps.getConfig?.().browser?.channel ?? DEFAULT_BROWSER_CHANNEL,
        timeoutMs: deps.renderTimeoutMs ?? RENDER_TIMEOUT_MS,
      },
      context?.abortSignal,
    );
  }
  if (mode === 'preview') {
    return runPreview(args, context, {
      channel: deps.getConfig?.().browser?.channel ?? DEFAULT_BROWSER_CHANNEL,
      baseTimeoutMs: deps.renderTimeoutMs ?? RENDER_TIMEOUT_MS,
      now: () => Date.now(),
    });
  }
  if (mode !== 'image') {
    throw new Error(
      `render_html_to_image: mode must be "image" or "preview", not ${JSON.stringify(mode)}.`,
    );
  }
  // Refused, not ignored: a preview call that forgot `mode` once got a static,
  // script-less PNG saved into the workspace with its frames and keys dropped.
  const previewOnly = ['wait_ms', 'frames', 'keys'].filter((key) => args[key] !== undefined);
  if (previewOnly.length > 0) {
    throw new Error(
      `render_html_to_image: ${previewOnly.join(', ')} apply to mode "preview" only; image mode ` +
        'runs no scripts. Add mode: "preview" to see the page run.',
    );
  }
  return runRender(deps, args, context);
}

async function runRender(
  deps: RenderHtmlDeps,
  args: Record<string, unknown>,
  context: ToolHandlerContext | undefined,
): Promise<string> {
  const rawHtml = args['html'];
  const rawPath = args['path'];
  const hasHtml = typeof rawHtml === 'string' && rawHtml.trim() !== '';
  const hasPath = typeof rawPath === 'string' && rawPath.trim() !== '';
  // Refuse rather than prefer one: a silent fallback would let a caller that
  // meant `path` render the stale `html` it left in the call.
  if (hasHtml && hasPath) {
    throw new Error(
      'render_html_to_image: give exactly one of html or path, not both — there is no fallback between them.',
    );
  }
  if (!hasHtml && !hasPath) {
    throw new Error('render_html_to_image: one of html or path is required.');
  }

  const width = readViewportPx(args['width'], 1024, 'width');
  const height = readViewportPx(args['height'], 1024, 'height');
  const fullPage = args['full_page'] === true;

  let html: string;
  if (hasHtml) {
    html = rawHtml as string;
    checkHtmlBytes(html, 'html');
  } else {
    html = await readHtmlFile(rawPath as string);
  }

  // Refuse a spent budget BEFORE spending anything. The budget is shared with
  // `send_file` and is owned by `UserNotificationService`, so the tool asks how
  // many sends are left rather than keeping its own counter. Checking here
  // instead of only at `deliverFile` means the 6th call in a turn launches no
  // browser, writes no PNG, and adds no Undo entry — the refusal costs nothing
  // (review NOTE, 2026-10-03). The `deliverFile` refusal below is still handled:
  // this is an early exit, not the enforcement point.
  const remaining = deps.notifications.remainingFileDeliveries(context?.conversationId);
  if (remaining <= 0) {
    throw new Error(
      `render_html_to_image: the per-turn file delivery limit is already spent (${remaining} left). ` +
        'Nothing was rendered. Send fewer files this turn, or render it in a later turn.',
    );
  }

  const outputDir = deps.getConfig?.().image_generation?.output_dir ?? DEFAULT_IMAGE_OUTPUT_DIR;
  const base = `${stamp((deps.now ?? (() => new Date()))())}-${slugFor(html)}`;
  const outputPosixDir = outputDir.replace(/\\/g, '/');
  const target = path.posix.join(outputPosixDir, `${base}.png`);
  const wanted = await resolveRealWorkspacePath(target, undefined, { allowMissing: true });
  // The output directory may not exist yet, and the reservation file below has
  // to live inside it, so create it first. Resolution came first: mkdir on the
  // lexical path would run ahead of the symlink/junction check.
  await fs.mkdir(path.dirname(wanted), { recursive: true });
  // Claim the name BEFORE rendering. The stamp has one-second granularity, and
  // `deliverFile` reads the path asynchronously from inside the queued task, so
  // a second render that lands on the same name while the first upload is still
  // pending would change what the FIRST delivery sends. The claim is an O_EXCL
  // file, so it holds against other extension hosts and other processes, not
  // just this one; a taken name moves to `-2`, `-3`, … (Codex review MUST-FIX,
  // 2026-10-03).
  const absolute = await claimUniquePath(wanted, base);
  try {
    // Everything from here to the delivery is under one `finally`, so no exit —
    // a throwing `beforeMutate`, a render error, a rejected write, an abort —
    // can leave the name reserved (Codex review MUST-FIX, 2026-10-03).
    // Checkpoint the path this call actually owns, not the first candidate: an
    // Undo must remove the file that was really written. The `.png` itself is
    // still absent here — the claim is a sidecar — so the checkpoint records it
    // as missing and Undo deletes it rather than restoring a placeholder.
    context?.beforeMutate([absolute]);

    const png = await renderPng(
      {
        html,
        width,
        height,
        fullPage,
        channel: deps.getConfig?.().browser?.channel ?? DEFAULT_BROWSER_CHANNEL,
        timeoutMs: deps.renderTimeoutMs ?? RENDER_TIMEOUT_MS,
        ...(fullPage ? { maxHeightPx: MAX_FULL_PAGE_HEIGHT_PX } : {}),
      },
      context?.abortSignal,
    );
    checkPng(png, fullPage);

    // An abort during the render must be seen before the write: the turn is over,
    // and queuing a delivery the user already cancelled is the defect (review
    // NOTE, 2026-10-03). ONE check here is enough, and the check cannot be moved
    // later: the write below is synchronous and `deliverFile` is called on the
    // very next statement, so no abort can be observed between them — the event
    // loop does not run inside a synchronous block. Checking after the write
    // would therefore be unreachable code, and checking only there would let a
    // cancelled turn leave a PNG nobody asked for.
    if (context?.abortSignal?.aborted) {
      throw new Error(
        'render_html_to_image: cancelled during rendering — nothing was written or sent.',
      );
    }

    // Atomic: a torn PNG must never reach deliverFile, which reads the path at
    // send time from inside the queued task. This reuses the repo's atomic-write
    // owner rather than hand-rolling tmp+rename, so it also gets the fsync, the
    // Windows EPERM/EBUSY rename-retry, and removal of the temp file when the
    // write itself fails. generate_image writes directly; this is new behaviour
    // for the image pipeline, chosen because the delivery is asynchronous.
    writeFileAtomicSync(absolute, png);

    const reached = await deps.notifications.deliverFile({
      ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
      text: `🖼 render_html: ${path.basename(absolute)}`,
      imagePath: absolute,
    });

    const dims = pngDimensions(png);
    // The claimed name, which may carry a `-2` suffix, so not `target`.
    const workspacePath = path.posix.join(outputPosixDir, path.basename(absolute));
    const head = `${RENDERED_IMAGE_PREFIX}${workspacePath} (PNG, ${png.length.toLocaleString()} bytes) at ${dims.width}x${dims.height}.`;
    if (reached.kind === 'refused') return `${head}\n${reached.reason}`;
    return reached.chats > 0
      ? `${head} Queued for ${reached.chats} remote chat(s).`
      : `${head} No remote chat is watching this turn, so the PNG is only saved in the workspace; send_file cannot send it either. You have not seen it: view_image shows it to you, and for scripts or animation, mode "preview" with frames shows it running.`;
  } finally {
    // The file now exists, so the reservation has done its job; on a failure it
    // is freed so the next call gets the base name. Never throws.
    await releaseClaim(absolute);
  }
}

/**
 * Suffix of the O_EXCL reservation file that owns a render name while the
 * render is in flight. Exported so the tests can name it exactly rather than
 * re-derive it.
 */
export const CLAIM_SUFFIX = '.forge-claim';

/**
 * Claim `wanted` (or `<stem>-2.png`, `-3.png`, …) for this call alone.
 *
 * Why this exists: the filename is `<second-granularity stamp>-<title slug>`,
 * so two renders of the same title inside one second collide. Overwriting is
 * not merely cosmetic here — `deliverFile` hands the PATH to a queued task that
 * reads the bytes later, so a second write to the same name can replace what
 * the FIRST delivery is about to upload, and both chats get the second image
 * (Codex review MUST-FIX, 2026-10-03).
 *
 * The claim is an exclusive create (`wx`) of a sidecar next to the name, so it
 * holds across processes — a probe-then-write sequence would not, and a second
 * VS Code window on the same workspace is a real competitor. The `.png` itself
 * is NOT pre-created: `beforeMutate` snapshots that path, and a checkpoint that
 * saw an existing 0-byte file would make Undo restore an empty PNG instead of
 * deleting it.
 *
 * A sidecar left by a crashed host is NOT reclaimed here. It blocks only its own
 * `<stamp>-<slug>` name, and the stamp carries the second, so that name will
 * never be requested again — the next render gets a fresh one. Reclaiming during
 * acquisition would need a compare-and-delete that two processes cannot race
 * (Codex review, 2026-10-03), for a benefit that does not exist. The leftover is
 * the same accepted, visible litter as the stray `.tmp` the atomic writer can
 * leave; see the state ledger in the plan doc.
 */
async function claimUniquePath(wanted: string, base: string): Promise<string> {
  const dir = path.dirname(wanted);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? wanted : path.join(dir, `${base}-${attempt + 1}.png`);
    try {
      await fs.stat(candidate);
      continue; // a real PNG already owns this name
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    try {
      // `wx` in writeFile: exclusive create, and the handle is opened and closed
      // by the call itself — no half-open handle for a later unlink to race.
      await fs.writeFile(`${candidate}${CLAIM_SUFFIX}`, '', { flag: 'wx' });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(
    `render_html_to_image: ${path.basename(wanted)} and 99 numbered variants already exist.`,
  );
}

/** Release the reservation so a failed render does not burn a filename. Never throws. */
async function releaseClaim(absolute: string): Promise<void> {
  try {
    await fs.rm(`${absolute}${CLAIM_SUFFIX}`, { force: true });
  } catch {
    // Best-effort: a leftover reservation blocks only its own second-stamped name.
  }
}

function checkPng(png: Buffer, fullPage: boolean): void {
  if (png.length > MAX_PNG_BYTES) {
    throw new Error(
      `render_html_to_image: the PNG is ${png.length.toLocaleString()} bytes; the limit is ${MAX_PNG_BYTES.toLocaleString()}. ` +
        'Reduce the viewport size or simplify the layout.',
    );
  }
  const dims = pngDimensions(png);
  if (fullPage && dims.height > MAX_FULL_PAGE_HEIGHT_PX) {
    throw new Error(
      `render_html_to_image: the page rendered ${dims.height} px tall; the full_page cap is ${MAX_FULL_PAGE_HEIGHT_PX}. ` +
        'Shorten the content or split it into two renders.',
    );
  }
}

/** `<timestamp>-<slug>.png` stamp, matching generate_image's shape. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/**
 * The `<title>` element, lowercased with anything that is not a letter or digit
 * collapsed to `-`, capped at 40 chars; `render` when there is none. Kept
 * ASCII-only to match `generate_image`: a Greek or Cyrillic title therefore
 * yields `render`, which is a cosmetic limitation, not a failure.
 */
function slugFor(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = (match?.[1] ?? '').trim().toLowerCase();
  const slug = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'render';
}
