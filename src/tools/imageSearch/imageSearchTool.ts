import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import type { ForgeConfig, ImageSearchConfig } from '../../config/types';
import type { ChatAttachmentRef, ChatMessage } from '../../llm/types';
import { IMAGE_SEARCH_THUMBNAILS_PREFIX } from '../../sidebar/toolResultView';
import type { UserNotificationService } from '../../sidebar/UserNotificationService';
import { MAX_VIEW_IMAGE_BYTES, mimeFromHeader } from '../imageTool';
import type { RegisteredTool, ToolHandlerContext } from '../ToolRegistry';
import { downloadThumbnails, pickThumbnails, type LensThumbnail } from './lensThumbnails';
import { uploadTemporaryImage } from './litterboxUpload';
import {
  formatLensResults,
  LENS_SEARCH_TYPES,
  searchLens,
  type LensSearchType,
} from './serpApiLens';

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
  search?: typeof searchLens;
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
          'Reverse image search with Google Lens: finds where an image appears online and what it shows. Uses the most recent image the user attached unless image_url is given. Takes 20-60 s and uses one search from a small monthly quota, so do not repeat a search that already returned results.',
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
            type: {
              type: 'string',
              enum: [...LENS_SEARCH_TYPES],
              description:
                'exact_matches = the same image elsewhere (find the original); visual_matches = similar images; products = shopping; all = identify it plus web pages and similar images. Default all.',
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
        detail: `Upload attached image #${index} to Litterbox (public link, deleted after 1 h) and search it with Google Lens via SerpApi.`,
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
  const type = parseType(args['type']);
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
    const data = await (deps.search ?? searchLens)({ imageUrl, type, apiKey, signal });
    const text = formatLensResults(data, type, config.max_results);
    const thumbnails = pickThumbnails(data, config.thumbnails);
    if (!thumbnails.length) return text;
    const footer = await saveAndDeliverThumbnails(deps, thumbnails, context, signal, now());
    return `${text}\n\n${footer}`;
  } catch (err) {
    if (timeout.aborted && !context?.abortSignal?.aborted) {
      throw new Error(
        `image_search timed out after ${Math.round(config.timeout_ms / 1000)} s ` +
          `(image_search.timeout_ms). Lens searches of type "all" can take about a minute.`,
      );
    }
    throw err;
  }
}

/**
 * Saves thumbnails for the sidebar and sends them to a watching remote chat.
 * Returns the lines the model reads, which state exactly what happened: a
 * claimed send with no chat watching would repeat ask_user's lie.
 */
async function saveAndDeliverThumbnails(
  deps: ImageSearchDeps,
  thumbnails: readonly LensThumbnail[],
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
    lines.push(`${IMAGE_SEARCH_THUMBNAILS_PREFIX}${saved.map((t) => t.relativePath).join(', ')}`);
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

function parseType(value: unknown): LensSearchType {
  if (value === undefined) return 'all';
  if (typeof value === 'string' && (LENS_SEARCH_TYPES as readonly string[]).includes(value)) {
    return value as LensSearchType;
  }
  throw new Error(`image_search: type must be one of ${LENS_SEARCH_TYPES.join(', ')}.`);
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
