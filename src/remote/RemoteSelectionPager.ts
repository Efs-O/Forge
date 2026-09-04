import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { formatRemoteDateTime } from './RemoteDateTime';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type {
  RemoteChannel,
  RemoteInboundDisposition,
  RemoteInboundEvent,
  RemoteSelectionControls,
} from './types';

const PAGE_SIZE = 10;
const SELECTION_TTL_MS = 10 * 60_000;

export interface RemoteSelectionContext {
  channel: RemoteChannel;
  store: RemoteRequestStore;
  host: ForgeHostFacade;
  signal: AbortSignal;
  modelNames: readonly string[];
  /** alias -> display name, from `remote.workspace_aliases`. */
  workspaceAliases: Readonly<Record<string, string>>;
  /** The alias whose configured path is this window's root, when one matches. */
  currentWorkspaceAlias?: string | undefined;
  /** Display name of the folder this window has open, alias or not. */
  currentWorkspaceName?: string | undefined;
}

type TextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;
type SelectionEvent = Extract<RemoteInboundEvent, { kind: 'selection' }>;
type SelectionKind = SelectionEvent['selectionKind'];

export async function sendConversationSelection(
  event: TextEvent,
  context: RemoteSelectionContext,
  pageArgument?: string,
): Promise<RemoteInboundDisposition> {
  const conversations = context.host
    .status()
    .conversations.slice()
    .sort((left, right) => right.updatedAt - left.updatedAt);
  if (conversations.length === 0) {
    await context.channel.send(event.chatId, 'Forge: no conversations are available.', {
      signal: context.signal,
    });
    return { kind: 'handled' };
  }
  const page = parseRequestedPage(pageArgument, conversations.length);
  if (page === undefined) {
    return {
      kind: 'rejected',
      reason: `usage: /list <page 1-${pageCount(conversations.length)}>`,
    };
  }
  const values = conversations.map((conversation) => conversation.id);
  const token = await context.store.issueSelection(
    event.channel,
    event.chatId,
    'conversations',
    values,
    SELECTION_TTL_MS,
  );
  await sendPage(event.chatId, context, 'conversations', token, values, page);
  return { kind: 'handled' };
}

export async function sendModelSelection(
  event: TextEvent,
  context: RemoteSelectionContext,
  pageArgument?: string,
): Promise<RemoteInboundDisposition> {
  if (context.modelNames.length === 0) {
    return { kind: 'rejected', reason: 'no configured models are available' };
  }
  const page = parseRequestedPage(pageArgument, context.modelNames.length);
  if (page === undefined) {
    return {
      kind: 'rejected',
      reason: `usage: /models <page 1-${pageCount(context.modelNames.length)}>`,
    };
  }
  const values = [...context.modelNames];
  const token = await context.store.issueSelection(
    event.channel,
    event.chatId,
    'models',
    values,
    SELECTION_TTL_MS,
  );
  await sendPage(event.chatId, context, 'models', token, values, page);
  return { kind: 'handled' };
}

/**
 * Alias lists are short, so this exists for the numbering rather than the
 * paging: `/new 2` should work the way `/model 2` and `/select 2` already do.
 * Sharing the pager also means the list gets expiry and the page keyboard for
 * free once discovery starts returning more than ten workspaces.
 */
export async function sendWorkspaceSelection(
  event: TextEvent,
  context: RemoteSelectionContext,
  pageArgument?: string,
): Promise<RemoteInboundDisposition> {
  const values = Object.keys(context.workspaceAliases);
  if (values.length === 0) {
    await context.channel.send(
      event.chatId,
      'Forge: no remote workspace aliases are configured. Add remote.workspace_aliases to config.yaml.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  const page = parseRequestedPage(pageArgument, values.length);
  if (page === undefined) {
    return {
      kind: 'rejected',
      reason: `usage: /workspace [list] <page 1-${pageCount(values.length)}>`,
    };
  }
  const token = await context.store.issueSelection(
    event.channel,
    event.chatId,
    'workspaces',
    values,
    SELECTION_TTL_MS,
  );
  await sendPage(event.chatId, context, 'workspaces', token, values, page);
  return { kind: 'handled' };
}

export async function handleRemoteSelectionAction(
  event: SelectionEvent,
  context: RemoteSelectionContext,
  dedupKey: string,
): Promise<RemoteInboundDisposition> {
  const admission = await context.store.beginControlEvent(dedupKey);
  if (admission === 'completed') return { kind: 'handled' };
  if (admission === 'unknown') {
    return { kind: 'rejected', reason: 'previous selection action outcome is unknown' };
  }
  try {
    const result = await executeSelectionAction(event, context);
    await context.store.finishControlEvent(dedupKey);
    return result;
  } catch (err) {
    await context.store.discardControlEvent(dedupKey);
    throw err;
  }
}

async function executeSelectionAction(
  event: SelectionEvent,
  context: RemoteSelectionContext,
): Promise<RemoteInboundDisposition> {
  const selection = context.store.selection(
    event.channel,
    event.chatId,
    event.selectionKind,
    event.selectionToken,
  );
  if (!selection) {
    return {
      kind: 'rejected',
      reason: `${kindLabel(event.selectionKind)} list expired; run ${commandFor(event.selectionKind)} again`,
    };
  }
  if (event.action === 'close') {
    await context.store.clearSelection(
      event.channel,
      event.chatId,
      event.selectionKind,
      event.selectionToken,
    );
    if (!context.channel.selectionPages) {
      return { kind: 'rejected', reason: 'this transport cannot close selection lists' };
    }
    await context.channel.selectionPages.close(event.chatId, event.messageId, {
      signal: context.signal,
    });
    return { kind: 'handled' };
  }
  if (event.page === undefined || event.page >= pageCount(selection.values.length)) {
    return { kind: 'rejected', reason: 'selection page is out of range' };
  }
  if (!context.channel.selectionPages) {
    return { kind: 'rejected', reason: 'this transport cannot navigate selection lists' };
  }
  const rendered = renderPage(context, event.selectionKind, selection.values, event.page);
  await context.channel.selectionPages.edit(
    event.chatId,
    event.messageId,
    rendered.text,
    rendered.controls(event.selectionToken),
    { signal: context.signal },
  );
  return { kind: 'handled' };
}

async function sendPage(
  chatId: string,
  context: RemoteSelectionContext,
  kind: SelectionKind,
  token: string,
  values: string[],
  page: number,
): Promise<void> {
  const rendered = renderPage(context, kind, values, page);
  if (context.channel.selectionPages) {
    await context.channel.selectionPages.send(chatId, rendered.text, rendered.controls(token), {
      signal: context.signal,
    });
    return;
  }
  await context.channel.send(chatId, rendered.text, { signal: context.signal });
}

function renderPage(
  context: RemoteSelectionContext,
  kind: SelectionKind,
  values: string[],
  page: number,
): { text: string; controls: (token: string) => RemoteSelectionControls } {
  const pages = pageCount(values.length);
  const start = page * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, values.length);
  const entries =
    kind === 'models'
      ? values.slice(start, end).map((name, index) => `${start + index + 1}. ${clip(name, 220)}`)
      : kind === 'workspaces'
        ? formatWorkspaces(context, values, start, end)
        : formatConversations(context, values, start, end);
  const heading = `Forge ${kind} ${start + 1}-${end} of ${values.length} · page ${page + 1}/${pages}`;
  const command =
    kind === 'models'
      ? '/model <number>'
      : kind === 'workspaces'
        ? '/new <number>'
        : '/select <number>';
  const fallback = pages > 1 ? ` Page fallback: ${commandFor(kind)} <page>.` : '';
  // A workspace list that does not say where you are answers half the question:
  // the "· current" marker only appears when the open folder is in the list.
  const here =
    kind === 'workspaces' && context.currentWorkspaceName
      ? `\n\nYou are in: ${clip(context.currentWorkspaceName, 180)}`
      : '';
  return {
    text: `${heading}\n\n${entries.join('\n')}${here}\n\nUse ${command}.${fallback} Selection expires in 10 minutes.`,
    controls: (token) => ({ kind, token, page, pageCount: pages }),
  };
}

/** The current workspace is marked so the list also answers "where am I?",
 *  which otherwise costs a second command. */
function formatWorkspaces(
  context: RemoteSelectionContext,
  values: string[],
  start: number,
  end: number,
): string[] {
  return values.slice(start, end).map((alias, index) => {
    const marker = alias === context.currentWorkspaceAlias ? ' · current' : '';
    return `${start + index + 1}. ${alias} — ${clip(context.workspaceAliases[alias] ?? alias, 180)}${marker}`;
  });
}

function formatConversations(
  context: RemoteSelectionContext,
  values: string[],
  start: number,
  end: number,
): string[] {
  const byId = new Map(
    context.host.status().conversations.map((conversation) => [conversation.id, conversation]),
  );
  return values.slice(start, end).map((id, index) => {
    const number = start + index + 1;
    const conversation = byId.get(id);
    if (!conversation) return `${number}. Unavailable conversation · ${shortId(id)}`;
    return `${number}. ${clip(conversation.title, 180)} · ${shortId(id)} · ${
      conversation.activeModel ?? 'default model'
    } · ${formatRemoteDateTime(conversation.updatedAt)}${conversation.archived ? ' · archived' : ''}`;
  });
}

function parseRequestedPage(argument: string | undefined, itemCount: number): number | undefined {
  if (argument === undefined) return 0;
  if (!/^\d+$/.test(argument)) return undefined;
  const page = Number(argument) - 1;
  return page >= 0 && page < pageCount(itemCount) ? page : undefined;
}

function pageCount(itemCount: number): number {
  return Math.ceil(itemCount / PAGE_SIZE);
}

function commandFor(kind: SelectionKind): '/list' | '/models' | '/workspace' {
  if (kind === 'conversations') return '/list';
  return kind === 'models' ? '/models' : '/workspace';
}

function kindLabel(kind: SelectionKind): 'conversation' | 'model' | 'workspace' {
  if (kind === 'conversations') return 'conversation';
  return kind === 'models' ? 'model' : 'workspace';
}

function shortId(id: string): string {
  return id.length > 7 ? `${id.slice(0, 3)}…${id.slice(-3)}` : id;
}

function clip(value: string, maxCharacters: number): string {
  const characters = [...value];
  return characters.length <= maxCharacters
    ? value
    : `${characters.slice(0, maxCharacters - 1).join('')}…`;
}
