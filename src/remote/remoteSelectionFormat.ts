import {
  modelPickerLabel,
  sortModelPickerEntries,
  type ModelPickerDescriptor,
} from '../sidebar/ModelPickerGroups';
import { escapeTelegramHtml } from './telegramHtml';
import { formatRemoteRelativeDate } from './RemoteDateTime';
import type { RemoteSelectionControls } from './types';

const OTHER_MODELS_GROUP = 'Other models';
const PAGE_SIZE = 10;

export interface SelectionFormatContext {
  modelEntries: readonly ModelPickerDescriptor[];
  workspaceAliases: Readonly<Record<string, string>>;
  currentWorkspaceAlias?: string | undefined;
  currentWorkspaceName?: string | undefined;
  currentModel?: string | null | undefined;
  currentConversationId?: string | undefined;
  conversations: readonly {
    id: string;
    title: string;
    activeModel: string | null;
    archived: boolean;
    updatedAt: number;
  }[];
  buttons: boolean;
}

export interface SelectionPageText {
  html: string;
  plain: string;
  controls: (token: string) => RemoteSelectionControls;
}

/** Direct HTML formatter for the three numeric remote pickers. */
export function formatSelectionPage(
  context: SelectionFormatContext,
  kind: RemoteSelectionControls['kind'],
  values: readonly string[],
  page: number,
): SelectionPageText {
  const pages = Math.max(1, Math.ceil(values.length / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, values.length);
  const rows = formatEntries(context, kind, values, start, end);
  const title = kind === 'conversations' ? 'Chats' : kind === 'models' ? 'Models' : 'Workspaces';
  const footer = selectionFooter(context, kind);
  const heading = `<b>${title}</b> <i>· ${start + 1}–${end} of ${values.length}</i>`;
  const plainHeading = `${title} · ${start + 1}–${end} of ${values.length}`;
  const pickIndexes = Array.from(
    { length: Math.max(0, end - start) },
    (_, offset) => start + offset,
  );
  return {
    html: [heading, ...rows.html, '', `<i>${escapeTelegramHtml(footer)}</i>`].join('\n'),
    plain: [plainHeading, ...rows.plain, '', footer].join('\n'),
    controls: (token) => ({ kind, token, page, pageCount: pages, pickIndexes }),
  };
}

function formatEntries(
  context: SelectionFormatContext,
  kind: RemoteSelectionControls['kind'],
  values: readonly string[],
  start: number,
  end: number,
): { html: string[]; plain: string[] } {
  if (kind === 'models') return formatModels(context, values, start, end);
  if (kind === 'workspaces') return formatWorkspaces(context, values, start, end);
  return formatConversations(context, values, start, end);
}

function formatModels(
  context: SelectionFormatContext,
  values: readonly string[],
  start: number,
  end: number,
): { html: string[]; plain: string[] } {
  const ordered = sortModelPickerEntries(context.modelEntries);
  const byName = new Map(ordered.map((model) => [model.name, model]));
  const html: string[] = [];
  const plain: string[] = [];
  let previousGroup: string | undefined;
  for (const [offset, name] of values.slice(start, end).entries()) {
    const model = byName.get(name);
    const group = model?.group ?? OTHER_MODELS_GROUP;
    if (group !== previousGroup) {
      if (previousGroup !== undefined) {
        html.push('');
        plain.push('');
      }
      html.push(`<b>${escapeTelegramHtml(group)}</b>`);
      plain.push(group);
      previousGroup = group;
    }
    const number = start + offset + 1;
    const label = modelPickerLabel(model ?? { name });
    const profiles = model?.profiles?.map((profile) => `@${profile}`) ?? [];
    const hint = profiles.length ? ` · ${profiles.map(escapeTelegramHtml).join(', ')}` : '';
    const current = name === context.currentModel ? ' · ● current' : '';
    html.push(`<b>${number}.</b> ${escapeTelegramHtml(label)}${hint}${current}`);
    plain.push(
      `${number}. ${label}${profiles.length ? ` · ${profiles.join(', ')}` : ''}${current}`,
    );
  }
  return { html, plain };
}

function formatWorkspaces(
  context: SelectionFormatContext,
  values: readonly string[],
  start: number,
  end: number,
): { html: string[]; plain: string[] } {
  const entries = values.slice(start, end).map((alias, offset) => {
    const name = context.workspaceAliases[alias] ?? alias;
    const current = alias === context.currentWorkspaceAlias ? ' · ● current' : '';
    const number = start + offset + 1;
    return {
      html: `<b>${number}.</b> ${escapeTelegramHtml(alias)} — ${escapeTelegramHtml(name)}${current}`,
      plain: `${number}. ${alias} — ${name}${current}`,
    };
  });
  return { html: entries.map((entry) => entry.html), plain: entries.map((entry) => entry.plain) };
}

function formatConversations(
  context: SelectionFormatContext,
  values: readonly string[],
  start: number,
  end: number,
): { html: string[]; plain: string[] } {
  const byId = new Map(
    context.conversations.map((conversation) => [conversation.id, conversation]),
  );
  const html: string[] = [];
  const plain: string[] = [];
  for (const [offset, id] of values.slice(start, end).entries()) {
    const number = start + offset + 1;
    const conversation = byId.get(id);
    if (offset > 0) {
      html.push('');
      plain.push('');
    }
    if (!conversation) {
      html.push(`<b>${number}.</b> Unavailable conversation`);
      plain.push(`${number}. Unavailable conversation`);
      continue;
    }
    const current = id === context.currentConversationId ? ' · ● current' : '';
    const title = clipOneLine(conversation.title, 60);
    const meta = `${conversation.activeModel ?? 'default'} · ${formatRemoteRelativeDate(conversation.updatedAt)}${conversation.archived ? ' · archived' : ''}`;
    html.push(`<b>${number}.</b> ${escapeTelegramHtml(title)}${current}`);
    html.push(escapeTelegramHtml(meta));
    plain.push(`${number}. ${title}${current}`);
    plain.push(meta);
  }
  return { html, plain };
}

function selectionFooter(
  context: SelectionFormatContext,
  kind: RemoteSelectionControls['kind'],
): string {
  if (context.buttons) {
    if (kind === 'conversations') {
      return `Workspace: ${context.currentWorkspaceName ?? 'unknown'} · tap a number to open`;
    }
    return 'Tap a number to switch';
  }
  if (kind === 'conversations') return 'Use /chat <number>.';
  if (kind === 'models') return 'Use /model <number>.';
  return 'Use /workspace <number>.';
}

function clipOneLine(value: string, maximum: number): string {
  const chars = [...value.replace(/[\r\n]+/gu, ' ')];
  return chars.length <= maximum ? chars.join('') : `${chars.slice(0, maximum - 1).join('')}…`;
}
