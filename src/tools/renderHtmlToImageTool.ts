import * as fs from 'fs/promises';
import * as path from 'path';
import { DEFAULT_BROWSER_CHANNEL } from '../config/browserSchema';
import { DEFAULT_IMAGE_OUTPUT_DIR } from '../config/imageGenerationSchema';
import type { ForgeConfig } from '../config/types';
import { writeFileAtomicSync } from '../util/atomicWrite';
import type { UserNotificationService } from '../sidebar/UserNotificationService';
import { resolveRealWorkspacePath } from '../util/WorkspacePaths';
import { pngDimensions } from './browser/BrowserSessionManager';
import { renderPng } from './renderHtml/renderEngine';
import type { RegisteredTool, ToolHandlerContext } from './ToolRegistry';

/** Guards against a pathological input rather than a plausible one. */
const MAX_HTML_BYTES = 10 * 1024 * 1024;
/** A PNG past this is already enormous; refusing beats shipping it to Telegram. */
const MAX_PNG_BYTES = 10 * 1024 * 1024;
const MIN_VIEWPORT_PX = 1;
const MAX_VIEWPORT_PX = 8_192;
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
          'Render an HTML/CSS/SVG page to a PNG image and send it to the remote chat watching ' +
          'this turn. Use for text-heavy graphics: posters, cards, invites, diagrams, ' +
          'infographics, or anything needing exact text, fonts, and layout. JavaScript and ' +
          'external resources are not supported — inline everything (system fonts, base64 ' +
          'images). Use generate_image for photographs and painterly scenes.',
        parameters: {
          type: 'object',
          properties: {
            html: {
              type: 'string',
              description:
                'Inline HTML — a full document or a fragment. Provide exactly one of html or path.',
            },
            path: {
              type: 'string',
              description:
                'Workspace-relative .html file to render. Provide exactly one of html or path.',
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
                'If true, the height is the content height (the poster case) instead of clipping to height. Default false.',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    // Writes a PNG into the workspace AND sends it to api.telegram.org, so a
    // profile with fetch off must not be able to push files out through it.
    permission: 'fetch',
    additionalPermissions: ['write'],
    // The output path is minted inside the handler (`<timestamp>-<slug>.png`),
    // so a paths() callback would compute a different timestamp and snapshot the
    // wrong file. The handler calls beforeMutate itself — that is the real
    // checkpoint mechanism (same reasoning as generate_image).
    mutation: { paths: () => [], showDiff: false },
    handler: (args, context) => runRender(deps, args, context),
  };
  return tool;
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
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
      throw new Error(
        `render_html_to_image: html is ${Buffer.byteLength(html, 'utf8').toLocaleString()} bytes; the limit is ${MAX_HTML_BYTES.toLocaleString()}.`,
      );
    }
  } else {
    const file = await resolveRealWorkspacePath(rawPath as string);
    const stat = await fs.stat(file);
    if (!stat.isFile()) {
      throw new Error(`render_html_to_image: not a file: ${String(rawPath)}`);
    }
    if (stat.size > MAX_HTML_BYTES) {
      throw new Error(
        `render_html_to_image: html file is ${stat.size.toLocaleString()} bytes; the limit is ${MAX_HTML_BYTES.toLocaleString()}.`,
      );
    }
    html = await fs.readFile(file, 'utf8');
    // Re-check after the read: `stat` is a snapshot, and a file that grew (or
    // was swapped for a symlink target) between `stat` and `readFile` would
    // otherwise slip past the cap. The byte length of the decoded string is what
    // Chrome will actually be handed.
    const readBytes = Buffer.byteLength(html, 'utf8');
    if (readBytes > MAX_HTML_BYTES) {
      throw new Error(
        `render_html_to_image: html file grew to ${readBytes.toLocaleString()} bytes while being read; the limit is ${MAX_HTML_BYTES.toLocaleString()}.`,
      );
    }
  }

  // Refuse a spent budget BEFORE spending anything. The budget is shared with
  // `send_file` and is owned by `UserNotificationService`, so the tool asks how
  // many sends are left rather than keeping its own counter. Checking here
  // instead of only at `deliverFile` means the 6th call in a turn launches no
  // browser, writes no PNG, and adds no Undo entry — the refusal costs nothing
  // (review NOTE, 2026-10-03). The `deliverFile` refusal below is still handled:
  // this is an early exit, not the enforcement point.
  const remaining = deps.notifications.remainingFileDeliveries?.(context?.conversationId);
  if (remaining !== undefined && remaining <= 0) {
    throw new Error(
      `render_html_to_image: the per-turn file delivery limit is already spent (${remaining} left). ` +
        'Nothing was rendered. Send fewer files this turn, or render it in a later turn.',
    );
  }

  const outputDir = deps.getConfig?.().image_generation?.output_dir ?? DEFAULT_IMAGE_OUTPUT_DIR;
  const base = `${stamp((deps.now ?? (() => new Date()))())}-${slugFor(html)}`;
  const target = path.posix.join(outputDir.replace(/\\/g, '/'), `${base}.png`);
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
    const head = `Rendered ${path.basename(absolute)} (PNG, ${png.length.toLocaleString()} bytes) at ${dims.width}x${dims.height}.`;
    if (reached.kind === 'refused') return `${head}\n${reached.reason}`;
    return reached.chats > 0
      ? `${head} Queued for ${reached.chats} remote chat(s).`
      : `${head} No remote chat is watching this turn.`;
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

function readViewportPx(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`render_html_to_image: ${name} must be an integer.`);
  }
  if (value < MIN_VIEWPORT_PX || value > MAX_VIEWPORT_PX) {
    throw new Error(
      `render_html_to_image: ${name} is ${value}; the range is ${MIN_VIEWPORT_PX}–${MAX_VIEWPORT_PX}.`,
    );
  }
  return value;
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
export function slugFor(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = (match?.[1] ?? '').trim().toLowerCase();
  const slug = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'render';
}
