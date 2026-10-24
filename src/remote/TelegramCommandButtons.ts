import type { RemoteContactButton } from './types';

const COMMANDS = {
  status: '/status',
  context: '/context',
  system: '/system',
  chats: '/chats',
  compact: '/compact',
  chatSolo: '/chatmode solo',
  chatMulti: '/chatmode multi',
} as const;

export type TelegramCommandName = keyof typeof COMMANDS;

/** Button whose callback maps to the ordinary typed command. */
export function telegramCommandButton(
  name: TelegramCommandName,
  text: string,
): RemoteContactButton {
  const callbackData = `k:${name}`;
  assertCallbackLength(callbackData);
  return { text, callbackData };
}

/** Strict allowlist parser; unknown names are never turned into commands. */
export function parseTelegramCommandCallback(data: string):
  | {
      name: TelegramCommandName;
      text: string;
    }
  | undefined {
  const match = /^k:(status|context|system|chats|compact|chatSolo|chatMulti)$/.exec(data);
  if (!match) return undefined;
  const name = match[1] as TelegramCommandName;
  return { name, text: COMMANDS[name] };
}

function assertCallbackLength(data: string): void {
  if (Buffer.byteLength(data, 'utf8') > 64) {
    throw new Error('Forge Telegram command callback exceeds the Bot API limit.');
  }
}
