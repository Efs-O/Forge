import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import {
  MODEL_PICKER_GROUP_ORDER,
  sortModelPickerEntries,
  type ModelPickerDescriptor,
} from '../sidebar/ModelPickerGroups';
import { boldLeadingNumber, boldNumberedLine, markupTelegramLines } from './telegramHtml';
import { formatRemoteDateTime } from './RemoteDateTime';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type {
  RemoteChannel,
  RemoteInboundDisposition,
  RemoteInboundEvent,
  RemoteSelectionControls,
} from './types';

/** Heading for a model whose group the picker could not classify. */
const OTHER_MODELS_GROUP = 'Other models';

const PAGE_SIZE = 10;
const SELECTION_TTL_MS = 10 * 60_000;

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
  const rendered = renderPage(context, event.selectionKind, selection.values, event.page);
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
  const rendered = renderPage(context, kind, values, page);
  if (context.channel.selectionPages) {
    await context.channel.selectionPages.send(chatId, rendered.text, rendered.controls(token), {
      signal: context.signal,
      ...(rendered.parseMode ? { parseMode: rendered.parseMode } : {}),
    });
    return;
  }
  await context.channel.send(chatId, rendered.text, { signal: context.signal });
}

/** Every heading `formatModels` can emit, as it appears once uppercased. */
const MODEL_GROUP_HEADINGS = new Set(
  [...MODEL_PICKER_GROUP_ORDER, OTHER_MODELS_GROUP].map((group) => group.toUpperCase()),
);

/**
 * Re-inserts the markup a selection page owns: its heading, its group headings
 * and its entry numbers.
 *
 * The text is escaped whole first, so a model name is content and nothing else.
 * Group headings are matched as complete lines against a fixed set, and entries
 * always start with "N. " -- which is why a name can never be mistaken for
 * either.
 */
function withSelectionMarkup(text: string, kind: SelectionKind): string {
  // A conversation entry is a number and a title on one line, with its ids and
  // timestamps on the next; bolding the whole line there bolds exactly the
  // title. A model or workspace entry carries its path or provider on the same
  // line, so only the number -- the part typed back -- is bolded.
  const entry = kind === 'conversations' ? boldNumberedLine : boldLeadingNumber;
  return markupTelegramLines(text, (line, index) => {
    if (index === 0) return `<b>${line}</b>`;
    if (MODEL_GROUP_HEADINGS.has(line)) return `<b><u>${line}</u></b>`;
    if (line.startsWith('You are in: '))
      return `<b>You are in:</b>${line.slice('You are in:'.length)}`;
    // The footer is instructions, not content: italic keeps it present without
    // letting it compete with the entries above it.
    if (line.startsWith('Use /')) return `<i>${line}</i>`;
    return entry(line);
  });
}

function renderPage(
  context: RemoteSelectionContext,
  kind: SelectionKind,
  values: string[],
  page: number,
): {
  text: string;
  parseMode?: 'HTML';
  controls: (token: string) => RemoteSelectionControls;
} {
  const pages = pageCount(values.length);
  const start = page * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, values.length);
  const entries =
    kind === 'models'
      ? formatModels(context, values, start, end)
      : kind === 'workspaces'
        ? formatWorkspaces(context, values, start, end)
        : formatConversations(context, values, start, end);
  const heading = `Forge ${kind} ${start + 1}-${end} of ${values.length} · page ${page + 1}/${pages}`;
  const command = `${pickCommandFor(kind)} <number>`;
  // No page fallback for workspaces: the number after /workspace is a
  // workspace, not a page, so naming one here would re-create the collision
  // this list exists to avoid. The inline keyboard is the only pager.
  // And no fallback line on a transport that has a keyboard: there the
  // Previous/Next buttons already page, so the text is dead weight (it is the
  // only pager on a plain-text transport like WhatsApp, which keeps it).
  const fallback =
    pages > 1 && kind !== 'workspaces' && !context.channel.selectionPages
      ? ` Page fallback: ${commandFor(kind)} <page>.`
      : '';
  // A workspace or conversation list that does not say where you are answers
  // half the question: /chats only ever shows this window's conversations, so
  // the line costs nothing and saves a /workspace round-trip after a switch.
  const here =
    (kind === 'workspaces' || kind === 'conversations') && context.currentWorkspaceName
      ? `\n\nYou are in: ${clip(context.currentWorkspaceName, 180)}`
      : '';
  const text = `${heading}\n\n${entries.join('\n')}${here}\n\nUse ${command}.${fallback} Selection expires in 10 minutes.`;
  // Rich text needs both capabilities: `sendHtml` says the transport parses it,
  // `selectionPages` says the page is delivered through the call that carries
  // the parse mode. Without the second, the plain-text fallback would print the
  // escaping as literal `&amp;`.
  const rich =
    context.channel.sendHtml !== undefined && context.channel.selectionPages !== undefined;
  return {
    text: rich ? withSelectionMarkup(text, kind) : text,
    ...(rich ? { parseMode: 'HTML' as const } : {}),
    controls: (token) => ({ kind, token, page, pageCount: pages }),
  };
}

function formatModels(
  context: RemoteSelectionContext,
  values: string[],
  start: number,
  end: number,
): string[] {
  const byName = new Map(context.modelEntries.map((model) => [model.name, model]));
  const lines: string[] = [];
  let previousGroup: string | undefined;
  for (const [offset, name] of values.slice(start, end).entries()) {
    const group = byName.get(name)?.group ?? OTHER_MODELS_GROUP;
    if (group !== previousGroup) {
      // Blank line before every group but the first: caps and underline make a
      // heading legible, whitespace is what makes the list scannable.
      if (previousGroup !== undefined) lines.push('');
      lines.push(group.toUpperCase());
      previousGroup = group;
    }
    const profiles = byName.get(name)?.profiles;
    const profileHint = profiles?.length
      ? ` · profiles: ${profiles.map((profile) => `@${profile}`).join(', ')}`
      : '';
    lines.push(`${start + offset + 1}. ${clip(name, 220)}${profileHint}`);
  }
  return lines;
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
  const lines: string[] = [];
  for (const [offset, id] of values.slice(start, end).entries()) {
    // Two lines and a blank between entries: a conversation carries a title,
    // an id, a model and a timestamp, and on a phone all four on one line wrap
    // into an unreadable block where no entry has a visible beginning.
    if (offset > 0) lines.push('');
    const number = start + offset + 1;
    const conversation = byId.get(id);
    if (!conversation) {
      lines.push(`${number}. Unavailable conversation`);
      lines.push(`    ${shortId(id)}`);
      continue;
    }
    lines.push(`${number}. ${clip(conversation.title, 180)}`);
    lines.push(
      `    ${shortId(id)} · ${conversation.activeModel ?? 'default model'} · ${formatRemoteDateTime(
        conversation.updatedAt,
      )}${conversation.archived ? ' · archived' : ''}`,
    );
  }
  return lines;
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

function shortId(id: string): string {
  return id.length > 7 ? `${id.slice(0, 3)}…${id.slice(-3)}` : id;
}

function clip(value: string, maxCharacters: number): string {
  const characters = [...value];
  return characters.length <= maxCharacters
    ? value
    : `${characters.slice(0, maxCharacters - 1).join('')}…`;
}
