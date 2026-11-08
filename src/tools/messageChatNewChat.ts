/**
 * `message_chat action=new`: open a chat nobody has spoken in yet, pin it to a
 * model, name it after the sender and the first words of its task, and send that
 * task as its first message.
 *
 * The three sidebar calls are one operation, not three: a chat created and left
 * unpinned is a chat on the stale `config.active_model`, and loading that model
 * spawns a second engine beside the one already serving the conversation that
 * asked. So the create and its pin go through the lock the agent bus's `--new`
 * also takes (`src/sidebar/newChatPrologue.ts`), and a pin that fails is refused
 * **before** delivery, because delivering to an unpinned chat would start a turn
 * on the wrong model — the very second server this ordering exists to prevent.
 */

import { deriveTitle } from '../sidebar/conversationTitle';
import { shortChatTitle } from '../sidebar/chatMessageText';
import { inNewChatPrologueLock } from '../sidebar/newChatPrologue';
import { resolvesToConfiguredModel } from '../config/modelReferences';
import type { ForgeConfig } from '../config/types';
import { BUS_CHAT_TITLE_LIMIT } from '../backend/agentMessageOptions';
import type { ChatRef } from './chatMessageResolver';
import {
  atText,
  awaitMessageChatDelivery,
  emitDeliveryActivity,
  formatDeliveryResult,
  messageChatSendLimit,
  MESSAGE_CHAT_WINDOW_MINUTES,
  MESSAGE_CHAT_WINDOW_MS,
  nextAllowedAt,
  pruneMessageChatWindow,
  recordAction,
  rollbackAction,
  type MessageChatActionContext,
  type MessageChatActionSidebar,
} from './messageChatShared';

/** What {@link openWorkerChat} did: the chat it opened, what it is called now,
 *  the model it ended on, and — when the pin failed — why, as text the sender
 *  has to act on. */
interface WorkerChatOpening {
  id: string;
  title: string;
  model?: string;
  pinError?: string;
}

/** Which model to pin the new chat to, and the refusal that says why a name is
 *  not usable. `model` is checked against this window's config only when the
 *  chat opens in this window: for one opened in another, that window's own
 *  advertised list decides, and a worker model only it has configured is a
 *  worker this window can ask for and could never run itself. Checked before
 *  anything is opened, so a name that points at nothing costs no chat, no
 *  counter and no second engine. */
export function pickWorkerModel(input: {
  requested?: string;
  senderModel?: string;
  openedHere: boolean;
  config?: ForgeConfig;
}): { pinModel?: string } | { refusal: string } {
  const { requested, senderModel, openedHere, config } = input;
  if (requested === undefined) return senderModel ? { pinModel: senderModel } : {};
  if (openedHere) {
    if (!config)
      return {
        refusal:
          "Error: message_chat cannot check a `model` name without the loaded config. Omit `model` to open the new chat on this chat's own model.",
      };
    if (!resolvesToConfiguredModel(config, requested))
      return {
        refusal: `Error: "${requested}" does not name a model in config.yaml (configured: ${
          config.models.map((model) => model.name).join(', ') || 'none'
        }). Nothing was created and no counter was used.`,
      };
  }
  // Passed on as it was given, not as the base name it resolved to, so a
  // `model@profile` keeps its profile — the agent bus hands the same strings to
  // `setConversationModel` unchanged.
  return { pinModel: requested };
}

/** A worker chat's name: who opened it and the first words of what they asked
 *  for, inside the cap `deriveTitle` enforces. The sender's title is cut to 16
 *  units so the task keeps the rest — a tab named `📨 Message from Sender (id
 *  sender): Ple…` tells a supervisor nothing about which worker it is. */
export function workerTitle(sender: ChatRef, message: string): string {
  return deriveTitle(`${shortChatTitle(sender.title, 16)}: ${message.replace(/\s+/g, ' ').trim()}`);
}

/** The same name for a chat that opens in ANOTHER window: it has to fit the
 *  `title` field that request carries, which is shorter than a tab's name, so
 *  the tail is cut rather than the head — the sender's name is the part that
 *  says whose worker it is. */
export function peerWorkerTitle(sender: ChatRef, message: string): string {
  const title = workerTitle(sender, message);
  return title.length <= BUS_CHAT_TITLE_LIMIT
    ? title
    : `${title.slice(0, BUS_CHAT_TITLE_LIMIT - 1)}…`;
}

/** Open the chat, pin its model, name it: the sidebar calls that must not
 *  interleave with another opener's. A pin failure is returned rather than
 *  thrown, because the chat exists either way and a throw would lose its id from
 *  the refusal the sender has to act on. */
async function openWorkerChat(
  facade: ReturnType<MessageChatActionSidebar['getHostFacade']>,
  input: MessageChatActionContext,
): Promise<WorkerChatOpening> {
  const created = await facade.createConversation({ activate: false, openedBy: input.selfId });
  const wantedTitle = workerTitle(input.sender, input.message);
  if (input.pinModel === undefined) {
    return {
      id: created.id,
      title: facade.applyAutoTitle?.(created.id, wantedTitle) ? wantedTitle : created.title,
      ...(created.activeModel ? { model: created.activeModel } : {}),
    };
  }
  try {
    await facade.setConversationModel(created.id, input.pinModel);
  } catch (error) {
    return {
      id: created.id,
      title: created.title,
      ...(created.activeModel ? { model: created.activeModel } : {}),
      pinError: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    id: created.id,
    title: facade.applyAutoTitle?.(created.id, wantedTitle) ? wantedTitle : created.title,
    model: input.pinModel,
  };
}

/** Preflight the chat cap, open the chat, then deliver its first message. Every
 *  failure path refunds the counters it burned, so a refused `new` costs the
 *  sender nothing it did not actually do. */
export async function createNewChat(input: MessageChatActionContext): Promise<string> {
  const { sidebar, window, at } = input;
  pruneMessageChatWindow(window, at);
  const sendLimit = messageChatSendLimit(window, true);
  if (sendLimit) return input.refuse(sendLimit);
  if (window.newChatsAt.length >= input.newChatsPerHour) {
    return input.refuse(
      `Error: the ${input.newChatsPerHour}-new-chat-per-${MESSAGE_CHAT_WINDOW_MINUTES}-min limit for this chat was reached; the next new chat is allowed at ${atText(nextAllowedAt(window.newChatsAt, MESSAGE_CHAT_WINDOW_MS))}.`,
    );
  }

  let facade: ReturnType<MessageChatActionSidebar['getHostFacade']>;
  try {
    facade = sidebar.getHostFacade();
    const blockers = facade.chatCapBlockers({ activate: false });
    if (blockers.length > 0) {
      return input.refuse(`Error: a new chat cannot be opened yet:\n${blockers.join('\n')}`);
    }
  } catch (error) {
    return input.refuse(`Error: message_chat could not check the chat cap: ${String(error)}.`);
  }

  recordAction(window, at, true, true, false);
  // The same prologue lock the agent bus's `--new` takes, so a create and its pin
  // cannot interleave with another opener's (`src/sidebar/newChatPrologue.ts`).
  let opened: WorkerChatOpening;
  try {
    opened = await inNewChatPrologueLock(() => openWorkerChat(facade, input));
  } catch (error) {
    rollbackAction(window, at, true, true, false);
    return input.refuse(`Error: message_chat could not create a new chat: ${String(error)}.`);
  }

  const target: ChatRef = {
    id: opened.id,
    title: opened.title,
    position: input.chats.length + 1,
    running: false,
    ...(opened.model ? { model: opened.model } : {}),
  };
  const name = input.formatName(target);
  if (opened.pinError) {
    rollbackAction(window, at, true, true, false);
    return input.refuse(
      `Error: ${name} is open but could not be pinned to ${input.pinModel}: ${opened.pinError} ` +
        `The first message was not sent, because a chat left on the window's default model loads a second engine. ` +
        `Close ${name}, or pin it by hand and send again.`,
    );
  }

  let result: Awaited<ReturnType<typeof awaitMessageChatDelivery>>;
  try {
    result = await awaitMessageChatDelivery(
      sidebar.deliverChatMessage(input.formatMessage(), target.id),
      input.signal,
    );
  } catch (error) {
    rollbackAction(window, at, true, true, false);
    return input.refuse(
      `Error: message_chat could not route the first message: ${String(error)}. The empty chat ${name} remains open; you can close it.`,
    );
  }
  if (result.kind === 'refused') {
    rollbackAction(window, at, true, true, false);
    return input.refuse(
      `Error: ${name} did not accept the first message: ${result.error} Nothing was delivered; the empty chat remains open and can be closed.`,
    );
  }

  emitDeliveryActivity(input, target, result, false);
  // The model belongs in the result: not pinning a worker is what makes it load a
  // second engine, and the sender cannot learn that from a chat id.
  return formatDeliveryResult(name, result, 'new', `model ${target.model ?? 'the window default'}`);
}
