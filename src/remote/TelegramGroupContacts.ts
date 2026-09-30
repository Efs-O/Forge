/**
 * The Telegram group-contact workflow, extracted from `TelegramContactService`
 * (pure move — no behaviour change). This is one cohesive concern: a contact
 * posting in a bound group, the owner setting up a group link, and a contact
 * escalating to the owner. Persistence stays owned by `RemoteContactStore`;
 * burst admission (`acceptContactMessage`) stays with the bursts map and
 * `processBurst` in the host service and is passed in as the one callback.
 */

import type {
  RemoteChannel,
  RemoteContactRecord,
  RemoteInboundDisposition,
  RemoteInboundEvent,
} from './types';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteContactStore } from './RemoteContactStore';
import type { RemoteAuditLog } from './RemoteAuditLog';
import { commandName, isCommand, ownerCommandText } from './telegramContactText';
import {
  contactGroupStrangerText,
  contactNameMatches,
  contactOwnerVisibleText,
} from './ContactPolicy';

type ContactTextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;

/**
 * The inputs the group workflow needs. It is a genuine concern with its own
 * real inputs (channel, auth, store, audit, signal); `acceptContactMessage` is
 * the single callback into the host service, because burst admission owns the
 * shared `bursts` map and must not be duplicated here.
 */
export interface TelegramGroupDeps {
  channel: RemoteChannel;
  auth: RemoteAuth;
  store: RemoteContactStore;
  audit?: RemoteAuditLog | undefined;
  signal: AbortSignal;
  /** Admit a (group) contact message into the burst queue; owned by the host service. */
  acceptContactMessage: (
    event: ContactTextEvent,
    contact: RemoteContactRecord,
    role?: 'contact' | 'owner',
  ) => Promise<RemoteInboundDisposition>;
}

/** Telegram group contact workflow; persistence remains owned by RemoteContactStore. */
export class TelegramGroupContacts {
  constructor(private readonly deps: TelegramGroupDeps) {}

  async handleGroup(event: RemoteInboundEvent): Promise<RemoteInboundDisposition | undefined> {
    const { channel, auth, store, audit, signal } = this.deps;
    if (event.channel !== 'telegram' || event.chatType === 'private') return undefined;
    if (event.kind !== 'text') {
      await audit?.record(event, 'contact_group_event_rejected').catch(() => undefined);
      return { kind: 'rejected', reason: 'only text is supported in contact groups' };
    }
    const ownerId = await auth.getOwner('telegram');
    if (ownerId && event.senderId === ownerId) return this.handleOwnerGroupMessage(event);
    const contact = store.groupContact(event.chatId);
    if (!contact || contact.telegramUserId !== event.senderId) {
      await audit?.record(event, 'contact_group_sender_rejected').catch(() => undefined);
      await channel
        .send(event.chatId, contactGroupStrangerText(), { signal })
        .catch(() => undefined);
      return { kind: 'rejected', reason: 'sender is not the contact bound to this group' };
    }
    await store.markGroupVerified(contact.id, event.chatId);
    if (isCommand(event.text)) {
      if (commandName(event.text) === 'owner') return this.escalateToOwner(event);
      await audit?.record(event, 'contact_group_command_rejected').catch(() => undefined);
      await channel.send(event.chatId, 'Only /owner is available to contacts.', { signal });
      return { kind: 'rejected', reason: 'contact command is not available' };
    }
    return this.deps.acceptContactMessage(event, contact);
  }

  private async handleOwnerGroupMessage(
    event: ContactTextEvent,
  ): Promise<RemoteInboundDisposition> {
    const { store, audit } = this.deps;
    if (
      commandName(event.text) === 'contact' &&
      /^\/contact(?:@\S+)?\s+link\s+/i.test(event.text)
    ) {
      return this.requestGroupLink(event);
    }
    const contact = store.groupContact(event.chatId);
    if (!contact || isCommand(event.text)) {
      await audit?.record(event, 'contact_owner_group_message').catch(() => undefined);
      return { kind: 'handled' };
    }
    return this.deps.acceptContactMessage(event, contact, 'owner');
  }

  private async requestGroupLink(event: ContactTextEvent): Promise<RemoteInboundDisposition> {
    const { channel, auth, store, audit, signal } = this.deps;
    if (!(await auth.ownerSessionAuthenticated('telegram'))) {
      await channel.send(event.chatId, 'Forge: authenticate with the owner privately first.', {
        signal,
      });
      return { kind: 'rejected', reason: 'owner session is not authenticated' };
    }
    const match = /^\/contact(?:@\S+)?\s+link\s+(.+)$/i.exec(event.text.trim());
    const name = match?.[1]?.trim();
    const contacts = name ? this.resolveContacts(name) : [];
    if (contacts.length !== 1) {
      await channel.send(
        event.chatId,
        contacts.length > 1
          ? 'Forge: multiple contacts match; use the short contact id.'
          : 'Forge: contact not found or not active.',
        { signal },
      );
      return { kind: 'rejected', reason: 'contact group link target is ambiguous' };
    }
    const link = await store.createGroupLink(
      contacts[0]!.id,
      event.chatId,
      event.senderId,
      event.chatTitle,
    );
    if (!link) {
      await channel.send(event.chatId, 'Forge: this contact or group already has a link.', {
        signal,
      });
      return { kind: 'rejected', reason: 'contact group link already exists' };
    }
    await channel.send(
      event.chatId,
      `Forge: group link created for ${contacts[0]!.displayName}. Confirm privately with /contact bind ${link.id}.`,
      { signal },
    );
    await channel.send(
      event.senderId,
      `Forge: confirm the Telegram group for ${contacts[0]!.displayName} with /contact bind ${link.id}. It expires in 10 minutes.`,
      { signal },
    );
    await audit?.record(event, 'contact_group_link_created', link.id).catch(() => undefined);
    return { kind: 'handled' };
  }

  private async escalateToOwner(event: ContactTextEvent): Promise<RemoteInboundDisposition> {
    const { channel, audit, signal } = this.deps;
    const request = ownerCommandText(event.text);
    if (!request) {
      await channel.send(event.chatId, 'Use /owner followed by your question or request.', {
        signal,
      });
      return { kind: 'rejected', reason: 'owner request is empty' };
    }
    await channel.send(event.chatId, contactOwnerVisibleText(), { signal });
    await audit?.record(event, 'contact_owner_escalated').catch(() => undefined);
    return { kind: 'handled' };
  }

  private resolveContacts(query: string): RemoteContactRecord[] {
    const contacts = this.deps.store.contacts(true);
    const byId = contacts.filter((contact) => contact.id === query || contact.id.startsWith(query));
    return byId.length > 0 ? byId : contactNameMatches(contacts, query);
  }
}
