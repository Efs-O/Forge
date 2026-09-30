/**
 * Pure Telegram command-text helpers, extracted from `TelegramContactService`
 * (pure move — no behaviour change). They parse the `/command` prefix of an
 * inbound message: stripping a `@botusername` suffix, reading the command
 * name, testing for a command at all, and pulling the body of an `/owner`
 * request. No state, no deps — shared by the contact service and the group
 * workflow.
 */

/** Drop a trailing `@botusername` from a `/command` so `/owner@mybot` is `/owner`. */
export function stripBotUsername(text: string): string {
  return text.replace(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?/, '/$1');
}

/** The lower-cased command name at the start of the text, or undefined. */
export function commandName(text: string): string | undefined {
  const match = /^\/([A-Za-z0-9_]+)(?:@\S+)?/.exec(text.trim());
  return match?.[1]?.toLocaleLowerCase();
}

/** Whether the text starts a Telegram command. */
export function isCommand(text: string): boolean {
  return /^\//.test(text.trim());
}

/** The body of an `/owner <request>` message, or '' when there is none. */
export function ownerCommandText(text: string): string {
  return stripBotUsername(text)
    .replace(/^\/owner(?:\s+|$)/i, '')
    .trim();
}
