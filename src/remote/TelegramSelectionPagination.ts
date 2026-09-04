import type { RemoteSelectionControls, RemoteSelectionPages } from './types';

export interface TelegramSelectionCallback {
  kind: RemoteSelectionControls['kind'];
  token: string;
  action: 'show' | 'close';
  page?: number;
}

/**
 * One table, both directions. A `kind === 'conversations' ? 'c' : 'm'` encoder
 * silently stamped workspace pages as models, so every Previous/Next/Close on a
 * `/workspace list` failed the kind check and reported the list as expired.
 */
const CODE_BY_KIND = { conversations: 'c', models: 'm', workspaces: 'w' } as const;
const KIND_BY_CODE = { c: 'conversations', m: 'models', w: 'workspaces' } as const;

type TelegramButton = { text: string; callback_data: string };
export type TelegramBotCall = (
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

export function createTelegramSelectionPages(call: TelegramBotCall): RemoteSelectionPages {
  return {
    send: (chatId, text, controls, options) =>
      sendTelegramSelectionPage(call, chatId, text, controls, options?.signal, options?.parseMode),
    edit: (chatId, messageId, text, controls, options) =>
      editTelegramSelectionPage(
        call,
        chatId,
        messageId,
        text,
        controls,
        options?.signal,
        options?.parseMode,
      ),
    close: (chatId, messageId, options) =>
      closeTelegramSelectionPage(call, chatId, messageId, options?.signal),
  };
}

export function telegramSelectionKeyboard(controls: RemoteSelectionControls): {
  inline_keyboard: TelegramButton[][];
} {
  const navigation: TelegramButton[] = [];
  if (controls.page > 0) {
    navigation.push({
      text: '◀ Previous',
      callback_data: encodeSelectionCallback(controls, controls.page - 1),
    });
  }
  if (controls.page + 1 < controls.pageCount) {
    navigation.push({
      text: 'Next ▶',
      callback_data: encodeSelectionCallback(controls, controls.page + 1),
    });
  }
  const rows = navigation.length > 0 ? [navigation] : [];
  rows.push([
    {
      text: '✕ Close',
      callback_data: encodeSelectionCallback(controls, 'x'),
    },
  ]);
  return { inline_keyboard: rows };
}

export function parseTelegramSelectionCallback(
  data: string,
): TelegramSelectionCallback | undefined {
  const match = /^s:([A-Za-z0-9_-]{12}):([cmw]):(x|[0-9])$/.exec(data);
  if (!match) return undefined;
  const kind = KIND_BY_CODE[match[2] as keyof typeof KIND_BY_CODE];
  if (match[3] === 'x') return { kind, token: match[1]!, action: 'close' };
  return { kind, token: match[1]!, action: 'show', page: Number(match[3]) };
}

export async function sendTelegramSelectionPage(
  call: TelegramBotCall,
  chatId: string,
  text: string,
  controls: RemoteSelectionControls,
  signal?: AbortSignal,
  parseMode?: 'HTML',
): Promise<void> {
  await call(
    'sendMessage',
    {
      chat_id: chatId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      reply_markup: telegramSelectionKeyboard(controls),
    },
    signal,
  );
}

export async function editTelegramSelectionPage(
  call: TelegramBotCall,
  chatId: string,
  messageId: string,
  text: string,
  controls: RemoteSelectionControls,
  signal?: AbortSignal,
  parseMode?: 'HTML',
): Promise<void> {
  await call(
    'editMessageText',
    {
      chat_id: chatId,
      message_id: parseMessageId(messageId),
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      reply_markup: telegramSelectionKeyboard(controls),
    },
    signal,
  );
}

export async function closeTelegramSelectionPage(
  call: TelegramBotCall,
  chatId: string,
  messageId: string,
  signal?: AbortSignal,
): Promise<void> {
  await call('deleteMessage', { chat_id: chatId, message_id: parseMessageId(messageId) }, signal);
}

function encodeSelectionCallback(controls: RemoteSelectionControls, target: number | 'x'): string {
  const data = `s:${controls.token}:${CODE_BY_KIND[controls.kind]}:${target}`;
  if (Buffer.byteLength(data, 'utf8') > 64) {
    throw new Error('Forge Telegram selection callback exceeds the Bot API limit.');
  }
  return data;
}

function parseMessageId(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Forge Telegram selection message id is invalid.');
  }
  return parsed;
}
