import type { RemoteChannel } from './types';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteOutboxDelivery } from './RemoteOutboxDelivery';

/**
 * Deliver a message to the owner's chat, whatever conversation it is bound to.
 * This is the jobs outbox's delivery route (B.4): a job runs in the window
 * holding the `jobs-scheduler` lease, which may not be the Telegram window, so
 * it cannot call the remote sink directly. The outbox watcher hands each item
 * here; the message lands in the owner chat through the same main bot, so
 * replies and `/job` commands work in it.
 *
 * Returns the number of chats reached (0 when the channel has no paired owner,
 * so the caller keeps the outbox file pending).
 */
export async function deliverOwnerNotification(
  channel: RemoteChannel,
  auth: RemoteAuth,
  store: RemoteRequestStore,
  outbox: RemoteOutboxDelivery,
  text: string,
): Promise<number> {
  const ownerChatId = await auth.getOwner(channel.name);
  if (!ownerChatId) return 0;
  await store.notifyOutbox(channel.name, ownerChatId, text);
  outbox.kick();
  return 1;
}
