import { randomBytes, randomUUID } from 'crypto';
import type {
  RemoteContactDisposition,
  RemoteContactGroupLinkRecord,
  RemoteContactOutboundRecord,
  RemoteContactOutboundState,
  RemoteContactPendingRecord,
  RemoteContactRecord,
  RemoteContactThreadMessage,
} from './types';
import type { RemoteRequestStore } from './RemoteRequestStore';

const GROUP_LINK_TTL_MS = 10 * 60_000;

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

  groupContact(groupChatId: string): RemoteContactRecord | undefined {
    return this.store.contactRead((state) =>
      state.contacts.find(
        (item) =>
          item.status === 'active' &&
          item.groupStatus === 'bound' &&
          item.groupChatId === groupChatId,
      ),
    );
  }

  groupLink(id: string): RemoteContactGroupLinkRecord | undefined {
    return this.store.contactRead((state) =>
      state.contactGroupLinks.find((item) => item.id === id),
    );
  }

  pendingGroupLink(groupChatId: string): RemoteContactGroupLinkRecord | undefined {
    return this.store.contactRead((state) =>
      state.contactGroupLinks.find(
        (item) => item.groupChatId === groupChatId && item.state === 'pending',
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
        groupStatus: 'unbound',
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
      contact.groupStatus = 'unbound';
      delete contact.groupChatId;
      delete contact.groupTitle;
      delete contact.groupBoundAt;
      delete contact.groupVerifiedAt;
      contact.updatedAt = Date.now();
      for (const link of draft.contactGroupLinks) {
        if (link.contactId === id && link.state === 'pending') {
          link.state = 'cancelled';
          link.updatedAt = Date.now();
        }
      }
      for (const outbound of draft.contactOutbound) {
        if (outbound.contactId === id && outbound.state === 'pending') {
          outbound.state = 'cancelled';
          outbound.updatedAt = Date.now();
        }
      }
      return true;
    });
  }

  async createGroupLink(
    contactId: string,
    groupChatId: string,
    ownerId: string,
    groupTitle?: string,
  ): Promise<RemoteContactGroupLinkRecord | undefined> {
    let result: RemoteContactGroupLinkRecord | undefined;
    await this.store.contactMutate((draft) => {
      const contact = draft.contacts.find((item) => item.id === contactId);
      if (!contact || contact.status !== 'active' || contact.groupStatus === 'bound') return;
      if (
        draft.contacts.some(
          (item) =>
            item.id !== contactId && item.status === 'active' && item.groupChatId === groupChatId,
        ) ||
        draft.contactGroupLinks.some(
          (item) => item.state === 'pending' && item.groupChatId === groupChatId,
        )
      ) {
        return;
      }
      const now = Date.now();
      const link: RemoteContactGroupLinkRecord = {
        id: randomBytes(18).toString('base64url'),
        contactId,
        groupChatId,
        ...(groupTitle ? { groupTitle } : {}),
        ownerId,
        createdAt: now,
        expiresAt: now + GROUP_LINK_TTL_MS,
        updatedAt: now,
        state: 'pending',
      };
      for (const previous of draft.contactGroupLinks) {
        if (previous.contactId === contactId && previous.state === 'pending') {
          previous.state = 'cancelled';
          previous.updatedAt = now;
        }
      }
      contact.groupStatus = 'link_pending';
      contact.updatedAt = now;
      draft.contactGroupLinks.push(link);
      result = link;
    });
    return result;
  }

  async confirmGroupLink(
    linkId: string,
    ownerId: string,
  ): Promise<'confirmed' | 'missing' | 'not_owned' | 'not_pending' | 'expired' | 'conflict'> {
    let result: 'confirmed' | 'missing' | 'not_owned' | 'not_pending' | 'expired' | 'conflict' =
      'missing';
    await this.store.contactMutate((draft) => {
      const link = draft.contactGroupLinks.find((item) => item.id === linkId);
      if (!link) return;
      if (link.ownerId !== ownerId) {
        result = 'not_owned';
        return;
      }
      if (link.state !== 'pending') {
        result = 'not_pending';
        return;
      }
      const now = Date.now();
      if (now >= link.expiresAt) {
        link.state = 'expired';
        link.updatedAt = now;
        result = 'expired';
        return;
      }
      const contact = draft.contacts.find((item) => item.id === link.contactId);
      if (!contact || contact.status !== 'active') {
        link.state = 'cancelled';
        link.updatedAt = now;
        result = 'conflict';
        return;
      }
      if (
        draft.contacts.some(
          (item) =>
            item.id !== contact.id &&
            item.status === 'active' &&
            item.groupStatus === 'bound' &&
            item.groupChatId === link.groupChatId,
        )
      ) {
        result = 'conflict';
        return;
      }
      contact.groupStatus = 'bound';
      contact.groupChatId = link.groupChatId;
      if (link.groupTitle) contact.groupTitle = link.groupTitle;
      contact.groupBoundAt = now;
      contact.groupVerifiedAt = undefined;
      contact.updatedAt = now;
      link.state = 'confirmed';
      link.updatedAt = now;
      result = 'confirmed';
    });
    return result;
  }

  async markGroupVerified(contactId: string, groupChatId: string): Promise<boolean> {
    let verified = false;
    await this.store.contactMutate((draft) => {
      const contact = draft.contacts.find(
        (item) =>
          item.id === contactId &&
          item.status === 'active' &&
          item.groupStatus === 'bound' &&
          item.groupChatId === groupChatId,
      );
      if (!contact) return;
      contact.groupVerifiedAt = Date.now();
      contact.updatedAt = Date.now();
      verified = true;
    });
    return verified;
  }

  async unbind(id: string): Promise<boolean> {
    let changed = false;
    await this.store.contactMutate((draft) => {
      const contact = draft.contacts.find((item) => item.id === id);
      if (!contact) return;
      contact.groupStatus = 'unbound';
      delete contact.groupChatId;
      delete contact.groupTitle;
      delete contact.groupBoundAt;
      delete contact.groupVerifiedAt;
      contact.updatedAt = Date.now();
      for (const link of draft.contactGroupLinks) {
        if (link.contactId === id && link.state === 'pending') {
          link.state = 'cancelled';
          link.updatedAt = Date.now();
        }
      }
      changed = true;
    });
    return changed;
  }

  async appendThread(message: RemoteContactThreadMessage): Promise<void> {
    await this.store.contactMutate((draft) => pushThread(draft, message));
  }

  /** Whether this inbound channel message was already admitted. */
  hasInbound(inboundKey: string): boolean {
    return this.store.contactRead((state) =>
      state.contactThread.some((item) => item.inboundKey === inboundKey),
    );
  }

  /**
   * Admit an inbound contact request as a `pending` row, refusing — in the same
   * mutation — one whose `inboundKey` is already stored. Returns false for a
   * redelivered duplicate. The row is written before the contact sees any
   * acknowledgement, so a reload can find the work again (`unfinished`).
   */
  async appendInbound(
    message: RemoteContactThreadMessage & { inboundKey: string },
  ): Promise<boolean> {
    return this.store.contactMutate((draft) => {
      if (draft.contactThread.some((item) => item.inboundKey === message.inboundKey)) return false;
      pushThread(draft, { ...message, disposition: 'pending' });
      return true;
    });
  }

  async setDisposition(
    ids: readonly string[],
    disposition: RemoteContactDisposition,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.store.contactMutate((draft) => {
      for (const item of draft.contactThread) {
        if (ids.includes(item.id)) item.disposition = disposition;
      }
    });
  }

  /**
   * The work a reload or crash interrupted, grouped by contact. A `running`
   * row older than the contact's latest assistant reply was answered before
   * the crash and is marked so here; what remains still needs an answer.
   */
  async reclaimUnfinished(): Promise<Map<string, RemoteContactThreadMessage[]>> {
    return this.store.contactMutate((draft) => {
      const open = new Map<string, RemoteContactThreadMessage[]>();
      for (const item of draft.contactThread) {
        if (item.disposition !== 'pending' && item.disposition !== 'running') continue;
        const answeredAt = draft.contactThread
          .filter((m) => m.contactId === item.contactId && m.role === 'assistant')
          .at(-1)?.createdAt;
        if (
          item.disposition === 'running' &&
          answeredAt !== undefined &&
          item.createdAt <= answeredAt
        ) {
          item.disposition = 'answered';
          continue;
        }
        open.set(item.contactId, [...(open.get(item.contactId) ?? []), item]);
      }
      return open;
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

/**
 * Append a thread row and keep the contact's last 20 — plus any request still
 * unfinished, which trimming must never drop before it is answered.
 */
function pushThread(
  draft: { contactThread: RemoteContactThreadMessage[] },
  message: RemoteContactThreadMessage,
): void {
  const thread = [...draft.contactThread, message];
  const keep = new Set(
    thread
      .filter((item) => item.contactId === message.contactId)
      .slice(-20)
      .map((item) => item.id),
  );
  draft.contactThread = thread.filter(
    (item) =>
      item.contactId !== message.contactId ||
      keep.has(item.id) ||
      item.disposition === 'pending' ||
      item.disposition === 'running',
  );
}
