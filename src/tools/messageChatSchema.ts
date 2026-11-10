/**
 * The `message_chat` tool's advertised actions, request shape and pinned
 * definition — the owner-approved eager schema the tool-schema budget test
 * (`test/unit/ToolSchemaBudget.test.ts`) measures, with no handler in it.
 *
 * Split out of `messageChatTool.ts` for the 500-line `max-lines` cap: the tool
 * file owns dispatch and delivery, this one owns what the model is told it may
 * ask for. Keeping the two apart is also what makes the gated additions testable
 * without a sidebar: `actionFlags` reads config, `actionList` turns flags into
 * the enum, and `messageChatDefinition` turns both into text.
 */

import { z } from 'zod';
import type { ForgeConfig } from '../config/types';
import type { RegisteredTool } from './ToolRegistry';

/** How long one `message_chat` message may be. It was 4,000 with no recorded
 *  reason, and a worker's final report is long by nature: one chat tried to send
 *  a 5,495-character report five times and was refused every time. 16,000 is the
 *  cap, and `MESSAGE_CHAT_MESSAGE_PART_CHARS` is what the refusal counts parts
 *  against, so a part a model measures by eye still fits under it. The number is
 *  in the description as well as the schema, because a model that cannot see the
 *  limit cannot plan around it. */
export const MESSAGE_CHAT_MESSAGE_MAX_CHARS = 16_000;
export const MESSAGE_CHAT_MESSAGE_PART_CHARS = 10_000;

/** Every field `message_chat` accepts, whatever the flags currently advertise.
 *  `model` is only ever offered with `new`, and `requestSchema` refuses it for
 *  the other actions, so a stale client call is refused rather than ignored. */
export const requestShapeSchema = z
  .object({
    action: z.string().min(1),
    to: z.string().max(200).optional(),
    message: z.string().min(1).max(MESSAGE_CHAT_MESSAGE_MAX_CHARS).optional(),
    model: z.string().min(1).max(200).optional(),
    /** Which OTHER window a `new` should open its chat in. Not a blob: it is
     *  matched against the closed set of windows answering on this machine. */
    window: z.string().min(1).max(200).optional(),
  })
  .strict();

export interface MessageChatActionFlags {
  newChat: boolean;
  steer: boolean;
}

/** Which of the two opt-in capabilities this window has. `view` is read-only and
 *  needs no flag, so it is not here: it is in the list every configuration gets. */
export function actionFlags(getConfig: (() => ForgeConfig) | undefined): MessageChatActionFlags {
  const permissions = getConfig?.().permissions?.chats;
  return { newChat: permissions?.new_chat ?? false, steer: permissions?.steer ?? false };
}

/** The actions this window offers, in the order the schema lists them. */
export function actionList(flags: MessageChatActionFlags): string[] {
  return [
    'list',
    'send',
    'view',
    ...(flags.newChat ? ['new'] : []),
    ...(flags.steer ? ['steer'] : []),
  ];
}

/** Validate an action against the flags, so a call that raced a config change
 *  gets a refusal naming the action instead of a handler that ignores it. */
export function requestSchema(flags: MessageChatActionFlags) {
  const actions = new Set(actionList(flags));
  return requestShapeSchema.superRefine((request, context) => {
    if (!actions.has(request.action)) {
      context.addIssue({ code: 'custom', path: ['action'], message: 'Action is not available.' });
    }
    if (request.action === 'new' && request.to !== undefined) {
      context.addIssue({ code: 'custom', path: ['to'], message: 'new does not take to.' });
    }
    if ((request.action === 'new' || request.action === 'steer') && request.message === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['message'],
        message: `${request.action} requires message.`,
      });
    }
    // `view` reads one named chat: an omitted `to` would otherwise fall through
    // to "the other running chat", and a sender supervising two workers would
    // read whichever chat happened to be busy rather than the one it asked for.
    if (request.action === 'view' && request.to === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'view requires to: name the chat with its id, tab number (#N), or title words.',
      });
    }
    if (request.action === 'view' && request.message !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['message'],
        message: 'view does not take message.',
      });
    }
    if (request.action !== 'new' && request.model !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['model'],
        message: 'model is only for new: a chat already open keeps its own model.',
      });
    }
    // `send`, `steer` and `view` aim at a chat, and a chat in another window is
    // already named by its id — a `window` there would say nothing they do not
    // already know, and a model that guesses a window can only guess wrong.
    if (request.action !== 'new' && request.window !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['window'],
        message: 'window is only for new: send, steer and view address a chat by its id.',
      });
    }
  });
}

export function messageChatDefinition(flags: MessageChatActionFlags): RegisteredTool['definition'] {
  const actions = actionList(flags);
  const additions = [
    '`view`: read what one named chat has done — its last prompt/answer pairs, at most 10; `to` is required, and reading changes nothing. `view` also reads a closed chat by id or title, and marks the result `closed`.',
    flags.newChat
      ? '`new`: open a fresh chat and send its first message. `model` is optional (a configured model name or alias); without it the new chat follows the model this chat is on. A title cannot be set here — the new chat is named after you and the first words of your message.'
      : '',
    flags.steer
      ? '`steer`: send a message to a chat, interrupting its active turn when it is busy; an idle chat starts a turn.'
      : '',
  ].filter(Boolean);
  return {
    type: 'function',
    function: {
      name: 'message_chat',
      description:
        "Message another Forge chat. `to` is a chat id, `#N` from `list`, or words from the chat's title — `#N` and title words mean this window's chats; a chat in another Forge window on this machine takes its id, or its first 8 or more characters when no other chat's id starts the same way. Omit `to` to reach the other chat when exactly one other chat is running (or open); otherwise an omitted `to` answers the chat in another window that last wrote to this one. No `list` needed first. A running chat reads it at its next tool round; an idle chat starts a turn. Replies arrive the same way. `list`: show the chats, including other windows'." +
        ' `action` defaults to `send` when a `message` is given, so a message alone is enough.' +
        (additions.length > 0 ? ` ${additions.join(' ')}` : ''),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: actions },
          to: {
            type: 'string',
            maxLength: 200,
            description:
              "Another chat only: use its chat id, its #N tab number from list, or words from its title. #N and title words reach only this window's chats; a chat in another window takes its id or a unique prefix of 8 or more characters. Never target this chat. A closed chat must be read with action: view.",
          },
          message: {
            type: 'string',
            minLength: 1,
            maxLength: MESSAGE_CHAT_MESSAGE_MAX_CHARS,
            description:
              `Write it as you would to a coworker: first person, call the other chat 'you', ` +
              `no formalities, no reports about yourself in the third person. At most ` +
              `${MESSAGE_CHAT_MESSAGE_MAX_CHARS.toLocaleString('en-US')} characters; send a ` +
              `longer message in parts.`,
          },
          ...(flags.newChat
            ? {
                model: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 200,
                  description:
                    'The model to open the new chat on: a name or alias from config.yaml. Omit it to follow the model this chat is on, so a worker does not load a second engine.',
                },
                window: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 200,
                  description:
                    'Open the new chat in ANOTHER Forge window on this machine: name it the way `list` prints it. Omit it to open the chat here.',
                },
              }
            : {}),
        },
        // No required field: a call that carries a `message` and no `action` is
        // the common slip (ten refused calls in seven chats, audited 2026-10-27)
        // and `send` is the least powerful action that takes a message. `new`
        // and `steer` create or interrupt a chat, so they stay explicit.
        required: [],
        additionalProperties: false,
      },
    },
  };
}
