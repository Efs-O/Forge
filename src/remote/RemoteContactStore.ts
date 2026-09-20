import { randomUUID } from 'crypto';
import type {
  RemoteContactOutboundRecord,
  RemoteContactOutboundState,
  RemoteContactPendingRecord,
  RemoteContactRecord,
  RemoteContactThreadMessage,
} from './types';
import type { RemoteRequestStore } from './RemoteRequestStore';

/** Contact-domain facade over the shared RemoteRequestStore document. */
export class RemoteContactStore {
  constructor(private readonly store: RemoteRequestStore) {}

  pending(): RemoteContactPendingRecord[] {
    return this.store
      .contactRead((state) => state.contactPending)
      .filter((item) => item.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  contacts(activeOnly = false): RemoteContactRecord[] {
    return this.store
      .contactRead((state) => state.contacts)
      .filter((item) => !activeOnly || item.status === 'active')
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  byId(id: string): RemoteContactRecord | undefined {
    return this.store.contactRead((state) => state.contacts.find((item) => item.id === id));
  }

  byTelegram(userId: string, chatId: string): RemoteContactRecord | undefined {
    return this.store.contactRead((state) =>
      state.contacts.find(
        (item) => item.telegramUserId === userId && item.telegramChatId === chatId,
      ),
    );
  }

  pendingByTelegram(userId: string, chatId: string): RemoteContactPendingRecord | undefined {
    return this.store.contactRead((state) =>
      state.contactPending.find(
        (item) => item.telegramUserId === userId && item.telegramChatId === chatId,
      ),
    );
  }

  outboundById(id: string): RemoteContactOutboundRecord | undefined {
    return this.store.contactRead((state) => state.contactOutbound.find((item) => item.id === id));
  }

  thread(contactId: string, limit = 10): RemoteContactThreadMessage[] {
    return this.store
      .contactRead((state) => state.contactThread)
      .filter((item) => item.contactId === contactId)
      .slice(-Math.max(0, Math.min(limit, 20)));
  }

  async createPending(userId: string, chatId: string): Promise<'created' | 'existing' | 'contact'> {
    return this.store.contactMutate((draft) => {
      if (
        draft.contacts.some(
          (item) => item.telegramUserId === userId && item.telegramChatId === chatId,
        )
      ) {
        return 'contact';
      }
      if (
        draft.contactPending.some(
          (item) => item.telegramUserId === userId && item.telegramChatId === chatId,
        )
      ) {
        return 'existing';
      }
      const now = Date.now();
      draft.contactPending.push({
        id: randomUUID(),
        telegramUserId: userId,
        telegramChatId: chatId,
        createdAt: now,
        updatedAt: now,
        status: 'pending',
      });
      return 'created';
    });
  }

  async approve(pendingId: string, displayName: string): Promise<RemoteContactRecord | undefined> {
    return this.store.contactMutate((draft) => {
      const pending = draft.contactPending.find(
        (item) => item.id === pendingId && item.status === 'pending',
      );
      if (!pending) return undefined;
      if (
        draft.contacts.some(
          (item) =>
            item.telegramUserId === pending.telegramUserId &&
            item.telegramChatId === pending.telegramChatId,
        )
      ) {
        pending.status = 'approved';
        pending.updatedAt = Date.now();
        return undefined;
      }
      const now = Date.now();
      const contact: RemoteContactRecord = {
        id: randomUUID(),
        displayName: displayName.trim(),
        telegramChatId: pending.telegramChatId,
        telegramUserId: pending.telegramUserId,
        role: 'contact_only',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      pending.status = 'approved';
      pending.updatedAt = now;
      draft.contacts.push(contact);
      return contact;
    });
  }

  async disable(id: string): Promise<boolean> {
    return this.store.contactMutate((draft) => {
      const contact = draft.contacts.find((item) => item.id === id);
      if (!contact || contact.status !== 'active') return false;
      contact.status = 'disabled';
      contact.updatedAt = Date.now();
      for (const outbound of draft.contactOutbound) {
        if (outbound.contactId === id && outbound.state === 'pending') {
          outbound.state = 'cancelled';
          outbound.updatedAt = Date.now();
        }
      }
      return true;
    });
  }

  async appendThread(message: RemoteContactThreadMessage): Promise<void> {
    await this.store.contactMutate((draft) => {
      draft.contactThread.push(message);
      const keep = new Set(
        draft.contactThread
          .filter((item) => item.contactId === message.contactId)
          .slice(-20)
          .map((item) => item.id),
      );
      draft.contactThread = draft.contactThread.filter(
        (item) => item.contactId !== message.contactId || keep.has(item.id),
      );
    });
  }

  async createOutbound(record: RemoteContactOutboundRecord): Promise<void> {
    await this.store.contactMutate((draft) => {
      draft.contactOutbound.push(record);
    });
  }

  async claim(
    id: string,
    ownerId: string,
    now = Date.now(),
  ): Promise<'claimed' | 'missing' | 'not_owned' | 'not_pending' | 'expired'> {
    return this.store.contactMutate((draft) => {
      const item = draft.contactOutbound.find((candidate) => candidate.id === id);
      if (!item) return 'missing';
      if (item.ownerId !== ownerId) return 'not_owned';
      if (item.state !== 'pending') return 'not_pending';
      if (now >= item.expiresAt) {
        item.state = 'expired';
        item.updatedAt = now;
        return 'expired';
      }
      item.state = 'confirmed';
      item.updatedAt = now;
      return 'claimed';
    });
  }

  async cancel(
    id: string,
    ownerId: string,
    now = Date.now(),
  ): Promise<'cancelled' | 'missing' | 'not_owned' | 'not_pending' | 'expired'> {
    return this.store.contactMutate((draft) => {
      const item = draft.contactOutbound.find((candidate) => candidate.id === id);
      if (!item) return 'missing';
      if (item.ownerId !== ownerId) return 'not_owned';
      if (item.state !== 'pending') return 'not_pending';
      if (now >= item.expiresAt) {
        item.state = 'expired';
        item.updatedAt = now;
        return 'expired';
      }
      item.state = 'cancelled';
      item.updatedAt = now;
      return 'cancelled';
    });
  }

  async setState(id: string, state: RemoteContactOutboundState): Promise<boolean> {
    return this.store.contactMutate((draft) => {
      const item = draft.contactOutbound.find((candidate) => candidate.id === id);
      if (!item || item.state === 'sent' || item.state === 'failed') return false;
      item.state = state;
      item.updatedAt = Date.now();
      return true;
    });
  }
}
