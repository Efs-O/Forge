import { formatChatMessage } from '../sidebar/chatMessageText';
import { formatChatId, formatChatList, type ChatRef } from './chatMessageResolver';

/** Add the actionable list to a message_chat refusal. */
export function listRefusal(message: string, chats: ChatRef[], selfId: string): string {
  return `${message}\n\n${formatChatList(chats, selfId)}`;
}

/** Format a local tell with an id that remains unambiguous in this tab set. */
export function messageFrom(sender: ChatRef, chats: ChatRef[], text: string): string {
  const senderId = formatChatId(sender.id, chats);
  return formatChatMessage(sender.title, senderId, text);
}
