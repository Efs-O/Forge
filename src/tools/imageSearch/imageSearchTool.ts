import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import type { ForgeConfig, ImageSearchConfig } from '../../config/types';
import type { ChatAttachmentRef, ChatMessage } from '../../llm/types';
import { formatThumbnailLine } from '../../sidebar/toolResultView';
import type { UserNotificationService } from '../../sidebar/UserNotificationService';
import { MAX_VIEW_IMAGE_BYTES, mimeFromHeader } from '../imageTool';
import type { RegisteredTool, ToolHandlerContext } from '../ToolRegistry';
import { downloadThumbnails, pickThumbnails, type ThumbnailCandidate } from './imageThumbnails';
import { uploadTemporaryImage } from './litterboxUpload';
import {
  formatLensResults,
  LENS_SEARCH_TYPES,
  lensThumbnailCandidates,
  searchLens,
  type LensSearchType,
} from './serpApiLens';
import { formatYandexResults, searchYandex, yandexThumbnailCandidates } from './yandexImages';

export const IMAGE_SEARCH_ENGINES = ['google_lens', 'yandex'] as const;
type ImageSearchEngine = (typeof IMAGE_SEARCH_ENGINES)[number];

/** Litterbox keeps files 1 h; reuse an upload only well inside that. */
const UPLOAD_REUSE_MS = 50 * 60 * 1000;

export interface ImageSearchDeps {
  getConfig: () => ForgeConfig;
  secrets: vscode.SecretStorage | undefined;
  /**
   * Absolute path of a stored chat attachment (`ChatAttachmentStore.resolve`).
   * Absent where no attachment store exists; attachment searches then fail
   * with a message instead of guessing a path.
   */
  resolveAttachment?: (relativePath: string) => string;
  /** Sends thumbnails to the remote chat watching the turn, as generate_image does. */
  notifications?: UserNotificationService;
  /** Injectable for tests. */
  upload?: typeof uploadTemporaryImage;
  searchLens?: typeof searchLens;
  searchYandex?: typeof searchYandex;
  downloadThumbnails?: typeof downloadThumbnails;
  readFile?: (filePath: string) => Promise<Uint8Array>;
  workspaceRoot?: () => string | undefined;
  now?: () => number;
}

interface ImageSource {
  kind: 'attachment' | 'url';
  /** Public URL, or the attachment's store-relative path. */
  ref: string;
  name: string;
}

export function makeImageSearchTool(deps: ImageSearchDeps): RegisteredTool {
  const searchConfig = (): ImageSearchConfig | undefined => deps.getConfig().image_search;
  // Store-relative path -> uploaded URL. In memory only: an upload outliving a
  // window reload is worth one more Litterbox request, not a persistence layer.
  const uploads = new Map<string, { url: string; at: number }>();
  return {
    // Canonical literal: scripts/tool-audit-catalog.mjs extracts it statically.
    definition: {
      type: 'function',
      function: {
        name: 'image_search',
        description:
          'Reverse image search: finds where an image appears online, what it shows, and similar images (thumbnails are shown to the user). Uses the most recent image the user attached unless image_url is given. Each call uses one search from a small monthly quota, so do not repeat a search that already returned results.',
        parameters: {
          type: 'object',
          properties: {
            attachment_index: {
              type: 'integer',
              minimum: 1,
              description:
                '1 = the most recent image the user attached in this conversation, 2 = the one before. Default 1.',
            },
            image_url: {
              type: 'string',
              description: 'Public http(s) image URL. Use instead of an attachment.',
            },
            engine: {
              type: 'string',
              enum: [...IMAGE_SEARCH_ENGINES],
              description:
                'google_lens (default): cleanest matches, 20-60 s. yandex: ~5 s, lists the largest copies of the image (best lead to an original), strong on faces and non-Western sites, noisier pages.',
            },
            type: {
              type: 'string',
              enum: [...LENS_SEARCH_TYPES],
              description:
                'google_lens only. exact_matches = the same image elsewhere (find the original); visual_matches = similar images; products = shopping; all = identify it plus web pages and similar images. Default all.',
            },
          },
          additionalProperties: false,
        },
      },
    },
    permission: 'search',
    advertise: () => searchConfig() !== undefined,
    approval: (args) => {
      const config = searchConfig();
      // The gate covers only a local file leaving the machine. A public URL is
      // already public, and an invalid call fails in the handler anyway.
      if (!config?.confirm_upload || args['image_url'] !== undefined) return undefined;
      const index = typeof args['attachment_index'] === 'number' ? args['attachment_index'] : 1;
      return {
        dangerous: false,
        detail: `Upload attached image #${index} to Litterbox (public link, deleted after 1 h) and reverse-search it via SerpApi.`,
      };
    },
    handler: (args, context) => runImageSearch(deps, uploads, searchConfig(), args, context),
  };
}

async function runImageSearch(
  deps: ImageSearchDeps,
  uploads: Map<string, { url: string; at: number }>,
  config: ImageSearchConfig | undefined,
  args: Record<string, unknown>,
  context: ToolHandlerContext | undefined,
): Promise<string> {
  if (!config) throw new Error('image_search: no image_search block in config.yaml.');
  const engine = parseEnum(args['engine'], IMAGE_SEARCH_ENGINES, 'google_lens', 'engine');
  const type = parseEnum(args['type'], LENS_SEARCH_TYPES, 'all', 'type');
  if (engine === 'yandex' && args['type'] !== undefined) {
    throw new Error('image_search: type applies to google_lens only. Drop type for engine yandex.');
  }
  const source = pickSource(args, context?.conversationMessages);

  const apiKey = await deps.secrets?.get(config.secret_key_name);
  if (!apiKey) {
    throw new Error(
      `image_search: no SerpApi key in SecretStorage under "${config.secret_key_name}". ` +
        `Run "Forge: Set Cloud Provider Token" with that key name.`,
    );
  }

  const timeout = AbortSignal.timeout(config.timeout_ms);
  const signal = context?.abortSignal ? AbortSignal.any([context.abortSignal, timeout]) : timeout;
  const now = deps.now ?? Date.now;
  try {
    let imageUrl = source.ref;
    if (source.kind === 'attachment') {
      const cached = uploads.get(source.ref);
      if (cached && now() - cached.at < UPLOAD_REUSE_MS) {
        imageUrl = cached.url;
      } else {
        imageUrl = await uploadAttachment(deps, source, signal);
        uploads.set(source.ref, { url: imageUrl, at: now() });
      }
    }
    const { text, candidates } = await runEngine(
      deps,
      engine,
      { imageUrl, type, apiKey, signal },
      config,
    );
    const thumbnails = pickThumbnails(candidates, config.thumbnails);
    if (!thumbnails.length) return text;
    const footer = await saveAndDeliverThumbnails(deps, thumbnails, context, signal, now());
    return `${text}\n\n${footer}`;
  } catch (err) {
    if (timeout.aborted && !context?.abortSignal?.aborted) {
      throw new Error(
        `image_search timed out after ${Math.round(config.timeout_ms / 1000)} s ` +
          `(image_search.timeout_ms). Google Lens searches of type "all" can take about a minute; engine yandex is faster.`,
      );
    }
    throw err;
  }
}

async function runEngine(
  deps: ImageSearchDeps,
  engine: ImageSearchEngine,
  request: { imageUrl: string; type: LensSearchType; apiKey: string; signal: AbortSignal },
  config: ImageSearchConfig,
): Promise<{ text: string; candidates: ThumbnailCandidate[] }> {
  if (engine === 'yandex') {
    const data = await (deps.searchYandex ?? searchYandex)(request);
    return {
      text: formatYandexResults(data, config.max_results),
      candidates: yandexThumbnailCandidates(data),
    };
  }
  const data = await (deps.searchLens ?? searchLens)(request);
  return {
    text: formatLensResults(data, request.type, config.max_results),
    candidates: lensThumbnailCandidates(data),
  };
}

/**
 * Saves thumbnails for the sidebar and sends them to a watching remote chat.
 * Returns the lines the model reads, which state exactly what happened: a
 * claimed send with no chat watching would repeat ask_user's lie.
 */
async function saveAndDeliverThumbnails(
  deps: ImageSearchDeps,
  thumbnails: readonly ThumbnailCandidate[],
  context: ToolHandlerContext | undefined,
  signal: AbortSignal,
  stamp: number,
): Promise<string> {
  const root = (deps.workspaceRoot ?? defaultWorkspaceRoot)();
  if (!root) return 'Thumbnails were not saved: no workspace folder is open.';
  const { saved, failures } = await (deps.downloadThumbnails ?? downloadThumbnails)(
    thumbnails,
    root,
    { stamp, signal },
  );
  const lines: string[] = [];
  if (saved.length) {
    lines.push(formatThumbnailLine(saved));
  }
  if (failures.length) {
    lines.push(`${failures.length} thumbnail(s) could not be saved: ${failures.join('; ')}`);
  }
  if (!saved.length || !deps.notifications) return lines.join('\n');

  let reached = 0;
  for (const [index, thumbnail] of saved.entries()) {
    const caption = [
      `🔎 ${index + 1}/${saved.length} ${thumbnail.title}${thumbnail.source ? ` — ${thumbnail.source}` : ''}`,
      thumbnail.link,
    ]
      .filter(Boolean)
      .join('\n');
    reached = Math.max(
      reached,
      await deps.notifications.deliverImage({
        ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
        text: caption,
        imagePath: thumbnail.absolutePath,
      }),
    );
  }
  lines.push(
    reached > 0
      ? `Sent ${saved.length} thumbnail(s) to ${reached} remote chat(s).`
      : 'No remote chat is watching this turn, so no thumbnails were sent to a phone.',
  );
  return lines.join('\n');
}

function defaultWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function parseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  name: string,
): T {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value))
    return value as T;
  throw new Error(`image_search: ${name} must be one of ${allowed.join(', ')}.`);
}

/** Exported for tests: which image a call means. */
export function pickSource(
  args: Record<string, unknown>,
  messages: readonly ChatMessage[] | undefined,
): ImageSource {
  const url = args['image_url'];
  const index = args['attachment_index'];
  if (url !== undefined) {
    if (index !== undefined) {
      throw new Error(
        'image_search: pass image_url OR attachment_index, not both. Drop attachment_index to search the URL.',
      );
    }
    if (typeof url !== 'string' || !/^https?:\/\/\S+$/iu.test(url.trim())) {
      throw new Error('image_search: image_url must be a public http(s) URL.');
    }
    return { kind: 'url', ref: url.trim(), name: url.trim() };
  }
  if (index !== undefined && (!Number.isInteger(index) || (index as number) < 1)) {
    throw new Error('image_search: attachment_index must be a whole number, 1 or more.');
  }
  const wanted = (index as number | undefined) ?? 1;
  const images = attachedImagesNewestFirst(messages);
  if (!images.length) {
    throw new Error(
      'image_search: no image is attached in this conversation. Ask the user to attach one, or pass image_url.',
    );
  }
  const picked = images[wanted - 1];
  if (!picked) {
    throw new Error(
      `image_search: attachment_index ${wanted} is out of range; this conversation has ${images.length} attached image(s).`,
    );
  }
  return { kind: 'attachment', ref: picked.relativePath, name: picked.name };
}

function attachedImagesNewestFirst(
  messages: readonly ChatMessage[] | undefined,
): ChatAttachmentRef[] {
  const images: ChatAttachmentRef[] = [];
  for (const message of [...(messages ?? [])].reverse()) {
    if (message.role !== 'user' || !message.attachments) continue;
    // Within one message, the last-listed file counts as the most recent.
    for (const ref of [...message.attachments].reverse()) {
      if (ref.mediaType.startsWith('image/')) images.push(ref);
    }
  }
  return images;
}

async function uploadAttachment(
  deps: ImageSearchDeps,
  source: ImageSource,
  signal: AbortSignal,
): Promise<string> {
  if (!deps.resolveAttachment) {
    throw new Error(
      'image_search: chat attachments are not stored in this window, so none can be searched.',
    );
  }
  const filePath = deps.resolveAttachment(source.ref);
  const bytes = await (deps.readFile ?? ((file) => fs.readFile(file)))(filePath).catch(
    (err: Error) => {
      throw new Error(
        `image_search: attachment "${source.name}" could not be read: ${err.message}`,
      );
    },
  );
  if (bytes.byteLength > MAX_VIEW_IMAGE_BYTES) {
    throw new Error(
      `image_search: "${source.name}" is ${bytes.byteLength.toLocaleString()} bytes; the limit is ${MAX_VIEW_IMAGE_BYTES.toLocaleString()}.`,
    );
  }
  // Never trust the extension or the recorded media type: the host would
  // publish whatever bytes it is given.
  const mime = mimeFromHeader(bytes);
  if (!mime)
    throw new Error(
      `image_search: attachment "${source.name}" is not a PNG, JPEG, GIF, BMP or WebP image.`,
    );
  return (deps.upload ?? uploadTemporaryImage)({ bytes, filename: source.name, mime, signal });
}
