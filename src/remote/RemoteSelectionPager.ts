import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { sortModelPickerEntries, type ModelPickerDescriptor } from '../sidebar/ModelPickerGroups';
import { selectModelProfile } from './RemoteModelProfileSelection';
import { SELECTION_TTL_MS } from './RemoteSelectionConstants';
import { formatSelectionPage } from './remoteSelectionFormat';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type {
  RemoteChannel,
  RemoteInboundDisposition,
  RemoteInboundEvent,
  RemoteSelectionControls,
} from './types';

const PAGE_SIZE = 10;

export interface RemoteSelectionContext {
  channel: RemoteChannel;
  store: RemoteRequestStore;
  host: ForgeHostFacade;
  signal: AbortSignal;
  modelEntries: readonly ModelPickerDescriptor[];
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
  const values = conversations.map((conversation) => conversation.id);
  const page = parseRequestedPage(pageArgument, values.length);
  if (page === undefined) {
    return {
      kind: 'rejected',
      reason: pageRejection(context, 'conversations', values, pageArgument),
    };
  }
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
  if (context.modelEntries.length === 0) {
    return { kind: 'rejected', reason: 'no configured models are available' };
  }
  // Keep the persisted list to one value per configured model. The selection
  // schema caps lists at 100 items; profiles remain selectable by typing the
  // displayed `base@profile` form and are validated below.
  const values = sortModelPickerEntries(context.modelEntries).map((model) => model.name);
  const page = parseRequestedPage(pageArgument, values.length);
  if (page === undefined) {
    return { kind: 'rejected', reason: pageRejection(context, 'models', values, pageArgument) };
  }
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
 * paging: `/workspace 2` should work the way `/model 2` and `/chat 2` already
 * do. Sharing the pager also means the list gets expiry and the page keyboard
 * for free once discovery starts returning more than ten workspaces.
 *
 * Deliberately takes NO page argument. `/workspace` numbers the workspaces
 * 1-N, so reinterpreting a number as a page put two number spaces on one
 * command: `/workspace 27` was answered with "takes a page number (1-3)" when
 * 27 was exactly the workspace the user meant. The inline next/prev keyboard
 * pages the list, which is the only paging anyone needed.
 */
export async function sendWorkspaceSelection(
  event: TextEvent,
  context: RemoteSelectionContext,
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
  const token = await context.store.issueSelection(
    event.channel,
    event.chatId,
    'workspaces',
    values,
    SELECTION_TTL_MS,
  );
  await sendPage(event.chatId, context, 'workspaces', token, values, 0);
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
  if (event.action === 'select') {
    return selectModelProfile(event, context);
  }
  if (event.action === 'noop') return { kind: 'handled' };
  if (event.action === 'pick') {
    return { kind: 'rejected', reason: 'selection pick was not routed through its command path' };
  }
  // Close is dismissal of a message, not an operation on a list, so it must
  // never be gated on the list still being live. Gating it left every expired
  // or superseded list -- a second /models supersedes the first -- with a
  // permanently dead x Close button and no way out but Telegram's own delete.
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
  if (event.page === undefined || event.page >= pageCount(selection.values.length)) {
    return { kind: 'rejected', reason: 'selection page is out of range' };
  }
  if (!context.channel.selectionPages) {
    return { kind: 'rejected', reason: 'this transport cannot navigate selection lists' };
  }
  const rendered = renderPage(
    context,
    event.selectionKind,
    selection.values,
    event.page,
    event.channel,
    event.chatId,
  );
  await context.channel.selectionPages.edit(
    event.chatId,
    event.messageId,
    rendered.text,
    rendered.controls(event.selectionToken),
    { signal: context.signal, ...(rendered.parseMode ? { parseMode: rendered.parseMode } : {}) },
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
  const rendered = renderPage(context, kind, values, page, context.channel.name, chatId);
  if (context.channel.selectionPages) {
    await context.channel.selectionPages.send(chatId, rendered.text, rendered.controls(token), {
      signal: context.signal,
      ...(rendered.parseMode ? { parseMode: rendered.parseMode } : {}),
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
  channel: RemoteInboundEvent['channel'],
  chatId: string,
): {
  text: string;
  parseMode?: 'HTML';
  controls: (token: string) => RemoteSelectionControls;
} {
  const binding = context.store.binding(channel, chatId);
  const status = context.host.status();
  const currentConversation = status.conversations.find(
    (conversation) => conversation.id === binding?.conversationId,
  );
  const formatted = formatSelectionPage(
    {
      modelEntries: context.modelEntries,
      workspaceAliases: context.workspaceAliases,
      currentWorkspaceAlias: context.currentWorkspaceAlias,
      currentWorkspaceName: context.currentWorkspaceName,
      currentModel: currentConversation?.activeModel,
      currentConversationId: binding?.conversationId,
      conversations: status.conversations,
      buttons:
        context.channel.parseMode !== undefined && context.channel.selectionPages !== undefined,
    },
    kind,
    values,
    page,
  );
  // Rich text needs both capabilities: `sendHtml` says the transport parses it,
  // `selectionPages` says the page is delivered through the call that carries
  // the parse mode. Without the second, the plain-text fallback would print the
  // escaping as literal `&amp;`.
  const rich =
    context.channel.sendHtml !== undefined && context.channel.selectionPages !== undefined;
  return {
    text: rich ? formatted.html : formatted.plain,
    ...(rich ? { parseMode: 'HTML' as const } : {}),
    controls: formatted.controls,
  };
}

/**
 * `/workspace 23` reads as "workspace 23" and parses as "page 23". Both
 * numbers are read off the same list, so the two meanings are
 * indistinguishable to the person typing -- and the bare range usage that came
 * back sent them looking for a paging mistake they had not made.
 *
 * Deliberately a hint and not a redirect: on a three-page list every number
 * from 1 to 3 is a valid page AND a valid item, so acting on the guess would
 * silently do the wrong thing for exactly the numbers typed most often.
 */
function pageRejection(
  context: RemoteSelectionContext,
  kind: SelectionKind,
  values: readonly string[],
  argument: string | undefined,
): string {
  const usage = `usage: ${commandFor(kind)} <page 1-${pageCount(values.length)}>`;
  if (argument === undefined || !/^\d+$/.test(argument)) return usage;
  const index = Number(argument);
  if (index < 1 || index > values.length) return usage;
  const target = describeValue(context, kind, values[index - 1]!);
  const label = kindLabel(kind);
  return (
    `${commandFor(kind)} takes a page number (1-${pageCount(values.length)}), not a ${label} number. ` +
    `For ${label} ${argument}${target ? ` (${target})` : ''}, use ${pickCommandFor(kind)} ${argument}.`
  );
}

/** The name the person would recognise from the list, for the hint above. */
function describeValue(
  context: RemoteSelectionContext,
  kind: SelectionKind,
  value: string,
): string | undefined {
  if (kind === 'workspaces') return clip(context.workspaceAliases[value] ?? value, 80);
  if (kind === 'models') return clip(value, 80);
  const conversation = context.host
    .status()
    .conversations.find((candidate) => candidate.id === value);
  return conversation ? clip(conversation.title, 80) : undefined;
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

function commandFor(kind: SelectionKind): '/chats' | '/models' | '/workspace' {
  if (kind === 'conversations') return '/chats';
  return kind === 'models' ? '/models' : '/workspace';
}

/** The command that picks one entry -- the other half of every numbered list.
 *  For workspaces it is the same command that lists them: `/workspace` alone
 *  lists, `/workspace 27` goes there. */
function pickCommandFor(kind: SelectionKind): '/chat' | '/model' | '/workspace' {
  if (kind === 'conversations') return '/chat';
  return kind === 'models' ? '/model' : '/workspace';
}

function kindLabel(kind: SelectionKind): 'conversation' | 'model' | 'workspace' {
  if (kind === 'conversations') return 'conversation';
  return kind === 'models' ? 'model' : 'workspace';
}

function clip(value: string, maxCharacters: number): string {
  const characters = [...value];
  return characters.length <= maxCharacters
    ? value
    : `${characters.slice(0, maxCharacters - 1).join('')}…`;
}
