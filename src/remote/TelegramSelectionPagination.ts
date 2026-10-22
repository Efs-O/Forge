import type { RemoteSelectionChoice, RemoteSelectionControls, RemoteSelectionPages } from './types';

export interface TelegramSelectionCallback {
  kind: RemoteSelectionControls['kind'];
  token: string;
  action: 'show' | 'close' | 'select' | 'pick' | 'noop';
  page?: number;
  choice?: number;
  index?: number;
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
    sendChoices: (chatId, text, choices, controls, options) =>
      sendTelegramSelectionChoices(
        call,
        chatId,
        text,
        choices,
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
  const rows: TelegramButton[][] = [];
  const picks = controls.pickIndexes ?? [];
  for (let offset = 0; offset < picks.length; offset += 5) {
    rows.push(
      picks.slice(offset, offset + 5).map((index) => ({
        text: String(index + 1),
        callback_data: encodeSelectionPick(controls, index),
      })),
    );
  }
  const navigation: TelegramButton[] = [];
  navigation.push({
    text: '‹ Prev',
    callback_data:
      controls.page > 0
        ? encodeSelectionCallback(controls, controls.page - 1)
        : encodeSelectionNoop(controls),
  });
  navigation.push({
    text: `${controls.page + 1} / ${controls.pageCount}`,
    callback_data: encodeSelectionNoop(controls),
  });
  navigation.push({
    text: 'Next ›',
    callback_data:
      controls.page + 1 < controls.pageCount
        ? encodeSelectionCallback(controls, controls.page + 1)
        : encodeSelectionNoop(controls),
  });
  rows.push(navigation);
  rows.push([
    {
      text: '✕ Close',
      callback_data: encodeSelectionCallback(controls, 'x'),
    },
  ]);
  return { inline_keyboard: rows };
}

function telegramChoiceKeyboard(
  controls: RemoteSelectionControls,
  choices: readonly RemoteSelectionChoice[],
): { inline_keyboard: TelegramButton[][] } {
  return {
    inline_keyboard: [
      ...choices.map((choice) => [
        {
          text: choice.label,
          callback_data: encodeSelectionChoice(controls, choice.value),
        },
      ]),
      [
        {
          text: '✕ Close',
          callback_data: encodeSelectionCallback(controls, 'x'),
        },
      ],
    ],
  };
}

export function parseTelegramSelectionCallback(
  data: string,
): TelegramSelectionCallback | undefined {
  const match = /^s:([A-Za-z0-9_-]{12}):([cmw]):(x|z|n\d{1,3}|[0-9]|p[0-9]{1,2})$/.exec(data);
  if (!match) return undefined;
  const kind = KIND_BY_CODE[match[2] as keyof typeof KIND_BY_CODE];
  if (match[3] === 'x') return { kind, token: match[1]!, action: 'close' };
  if (match[3] === 'z') return { kind, token: match[1]!, action: 'noop' };
  if (match[3]!.startsWith('n')) {
    return { kind, token: match[1]!, action: 'pick', index: Number(match[3]!.slice(1)) };
  }
  if (match[3]!.startsWith('p')) {
    return {
      kind,
      token: match[1]!,
      action: 'select',
      choice: Number(match[3]!.slice(1)),
    };
  }
  return { kind, token: match[1]!, action: 'show', page: Number(match[3]) };
}

async function sendTelegramSelectionPage(
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

async function editTelegramSelectionPage(
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

async function closeTelegramSelectionPage(
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

function encodeSelectionPick(controls: RemoteSelectionControls, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 999) {
    throw new Error('Forge Telegram selection index is invalid.');
  }
  const data = `s:${controls.token}:${CODE_BY_KIND[controls.kind]}:n${index}`;
  if (Buffer.byteLength(data, 'utf8') > 64) {
    throw new Error('Forge Telegram selection callback exceeds the Bot API limit.');
  }
  return data;
}

function encodeSelectionNoop(controls: RemoteSelectionControls): string {
  return `s:${controls.token}:${CODE_BY_KIND[controls.kind]}:z`;
}

function encodeSelectionChoice(controls: RemoteSelectionControls, choice: number): string {
  const data = `s:${controls.token}:${CODE_BY_KIND[controls.kind]}:p${choice}`;
  if (Buffer.byteLength(data, 'utf8') > 64) {
    throw new Error('Forge Telegram selection callback exceeds the Bot API limit.');
  }
  return data;
}

async function sendTelegramSelectionChoices(
  call: TelegramBotCall,
  chatId: string,
  text: string,
  choices: readonly RemoteSelectionChoice[],
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
      reply_markup: telegramChoiceKeyboard(controls, choices),
    },
    signal,
  );
}

function parseMessageId(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Forge Telegram selection message id is invalid.');
  }
  return parsed;
}
