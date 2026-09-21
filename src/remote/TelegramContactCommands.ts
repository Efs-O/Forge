import { randomBytes, randomUUID } from 'crypto';
import { MAX_CONTACT_TEXT, contactNameMatches } from './ContactPolicy';
import type { RemoteAuditLog } from './RemoteAuditLog';
import type { RemoteAuth } from './RemoteAuth';
import { RemoteContactStore } from './RemoteContactStore';
import type {
  RemoteChannel,
  RemoteContactOutboundRecord,
  RemoteContactRecord,
  RemoteInboundDisposition,
  RemoteInboundEvent,
} from './types';

type ContactTextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;
type ContactActionEvent = Extract<RemoteInboundEvent, { kind: 'contact_action' }>;

/** Owner-only command and confirmation handling for the Telegram contact facade. */
export class TelegramContactCommands {
  constructor(
    private readonly channel: RemoteChannel,
    private readonly auth: RemoteAuth,
    private readonly store: RemoteContactStore,
    private readonly audit: RemoteAuditLog | undefined,
    private readonly onError: ((message: string) => void) | undefined,
    private readonly signal: AbortSignal,
    private readonly onContactStateChanged?: (contactId: string) => void,
  ) {}

  async handleAction(event: ContactActionEvent): Promise<RemoteInboundDisposition> {
    const ownerId = await this.auth.getOwner('telegram');
    const draft = this.store.outboundById(event.correlationId);
    if (!ownerId || !draft || event.senderId !== ownerId || event.chatId !== draft.ownerChatId) {
      await this.audit?.record(event, 'contact_foreign_callback').catch(() => undefined);
      await this.answerCallback(event, 'This approval is not yours.');
      return { kind: 'rejected', reason: 'contact callback is not owned by this chat' };
    }
    this.auth.touch(event);
    if (event.action === 'cancel') {
      const result = await this.store.cancel(draft.id, ownerId);
      await this.finishCallback(event, result === 'cancelled' ? 'Cancelled.' : 'Already handled.');
      await this.audit
        ?.record(event, result === 'cancelled' ? 'contact_cancelled' : 'contact_duplicate_callback')
        .catch(() => undefined);
      return result === 'cancelled'
        ? { kind: 'handled' }
        : { kind: 'rejected', reason: 'contact draft is no longer pending' };
    }
    const result = await this.store.claim(draft.id, ownerId);
    if (result !== 'claimed') {
      await this.finishCallback(event, result === 'expired' ? 'Expired.' : 'Already handled.');
      await this.audit
        ?.record(
          event,
          result === 'not_owned' ? 'contact_foreign_callback' : 'contact_duplicate_callback',
        )
        .catch(() => undefined);
      return { kind: 'rejected', reason: 'contact draft is no longer pending' };
    }
    await this.finishCallback(event, 'Sending.');
    try {
      const contact = this.store.byId(draft.contactId);
      if (
        !contact ||
        contact.status !== 'active' ||
        contact.groupStatus !== 'bound' ||
        contact.groupChatId !== draft.recipientChatId
      ) {
        await this.store.setState(draft.id, 'failed');
        await this.audit?.record(event, 'contact_send_stale').catch(() => undefined);
        return { kind: 'rejected', reason: 'contact group is no longer linked' };
      }
      await this.channel.send(draft.recipientChatId, draft.text, { signal: this.signal });
      await this.store.setState(draft.id, 'sent');
      await this.store.appendThread({
        id: randomUUID(),
        contactId: draft.contactId,
        role: 'assistant',
        text: draft.text,
        createdAt: Date.now(),
      });
      await this.audit?.record(event, 'contact_sent', draft.id).catch(() => undefined);
      return { kind: 'handled' };
    } catch (error) {
      await this.store.setState(draft.id, 'failed');
      await this.audit?.record(event, 'contact_send_failed', draft.id).catch(() => undefined);
      await this.notifyOwner(
        ownerId,
        `Forge: the approved message to ${draft.recipientDisplayName} could not be delivered.`,
      ).catch(() => undefined);
      this.onError?.(
        `Forge contact delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { kind: 'handled' };
    }
  }

  async handleOwnerCommand(event: ContactTextEvent): Promise<RemoteInboundDisposition | undefined> {
    const text = event.text.trim();
    if (!/^\/(?:contacts?|send)(?:\s|$)/i.test(text)) return undefined;
    if (/^\/contacts?\s+pending$/i.test(text)) {
      const pending = this.store.pending();
      await this.channel.send(
        event.chatId,
        pending.length === 0
          ? 'Forge: no pending contact requests.'
          : `Forge: pending contacts:\n${pending.map((item) => `- ${item.id.slice(0, 8)}`).join('\n')}`,
        { signal: this.signal },
      );
      return { kind: 'handled' };
    }
    if (/^\/contacts?\s+list$/i.test(text)) {
      const contacts = this.store.contacts(true);
      await this.channel.send(
        event.chatId,
        contacts.length === 0
          ? 'Forge: no active contacts.'
          : `Forge: active contacts:\n${contacts
              .map((item) => `- ${item.displayName} (${item.id.slice(0, 8)}, ${item.groupStatus})`)
              .join('\n')}`,
        { signal: this.signal },
      );
      return { kind: 'handled' };
    }
    const approval = /^\/contact\s+approve\s+(\S+)\s+(.+)$/is.exec(text);
    if (approval) {
      const displayName = approval[2]!.trim();
      const pending = this.findByShortId(
        approval[1]!,
        this.store.pending().map((item) => item.id),
      );
      if (!displayName || displayName.length > 80 || pending.length !== 1) {
        return this.sendOwnerUsage(event, 'usage: /contact approve <pending-id> <display-name>');
      }
      const contact = await this.store.approve(pending[0]!, displayName);
      await this.channel.send(
        event.chatId,
        contact
          ? `Forge: contact approved as ${contact.displayName}; now link a private group with /contact link ${contact.displayName}.`
          : 'Forge: contact request is no longer pending.',
        { signal: this.signal },
      );
      await this.audit
        ?.record(event, contact ? 'contact_approved' : 'contact_duplicate_rejected')
        .catch(() => undefined);
      return { kind: 'handled' };
    }
    const bind = /^\/contact\s+bind\s+(\S+)$/i.exec(text);
    if (bind) {
      const result = await this.store.confirmGroupLink(bind[1]!, event.senderId);
      await this.channel.send(event.chatId, this.groupLinkResult(result), {
        signal: this.signal,
      });
      await this.audit?.record(event, `contact_group_bind_${result}`).catch(() => undefined);
      return { kind: result === 'confirmed' ? 'handled' : 'rejected', reason: result };
    }
    const disable = /^\/contact\s+disable\s+(.+)$/is.exec(text);
    if (disable) return this.changeGroupState(event, disable[1]!.trim(), 'disable');
    const unbind = /^\/contact\s+unbind\s+(.+)$/is.exec(text);
    if (unbind) return this.changeGroupState(event, unbind[1]!.trim(), 'unbind');
    const direct = /^\/send\s+([^:]+):\s*([\s\S]+)$/i.exec(text);
    if (direct) {
      const message = direct[2]!.trim();
      if (!message || message.length > MAX_CONTACT_TEXT) {
        return this.sendOwnerUsage(event, 'usage: /send <name>: <message up to 12000 characters>');
      }
      const matches = this.resolveContacts(direct[1]!.trim());
      if (matches.length !== 1) {
        return this.sendOwnerUsage(
          event,
          matches.length > 1
            ? 'Forge: multiple contacts match; use the short contact id.'
            : 'Forge: contact not found.',
        );
      }
      if (matches[0]!.groupStatus !== 'bound') {
        return this.sendOwnerUsage(event, 'Forge: link this contact to a group first.');
      }
      await this.createAndPreview(matches[0]!, event.senderId, message, event);
      return { kind: 'handled' };
    }
    return this.sendOwnerUsage(
      event,
      'usage: /contacts pending|list, /contact approve|bind|link|disable|unbind, or /send <name>: <message>',
    );
  }

  private async createAndPreview(
    contact: RemoteContactRecord,
    ownerId: string,
    text: string,
    source?: ContactTextEvent,
  ): Promise<void> {
    const recipientChatId = contact.groupChatId;
    if (contact.groupStatus !== 'bound' || !recipientChatId) {
      throw new Error('contact group is not linked');
    }
    const sendInlineKeyboard = this.channel.sendInlineKeyboard;
    if (!sendInlineKeyboard) throw new Error('contact approval transport is unavailable');
    const now = Date.now();
    const draft: RemoteContactOutboundRecord = {
      id: randomBytes(18).toString('base64url'),
      contactId: contact.id,
      ownerId,
      ownerChatId: ownerId,
      recipientChatId,
      recipientDisplayName: contact.displayName,
      text,
      createdAt: now,
      expiresAt: now + 10 * 60_000,
      updatedAt: now,
      state: 'pending',
    };
    await this.store.createOutbound(draft);
    await this.audit
      ?.record(source ?? this.syntheticEvent(contact), 'contact_draft_created', draft.id)
      .catch(() => undefined);
    try {
      await sendInlineKeyboard.call(
        this.channel,
        ownerId,
        `${contact.displayName} asked:\n[owner-supplied message]\n\nForge drafted:\n${text}`,
        [
          [
            { text: 'Send', callbackData: `c:${draft.id}:s` },
            { text: 'Cancel', callbackData: `c:${draft.id}:c` },
          ],
        ],
        { signal: this.signal },
      );
      await this.audit
        ?.record(source ?? this.syntheticEvent(contact), 'contact_owner_previewed', draft.id)
        .catch(() => undefined);
    } catch (error) {
      await this.store.setState(draft.id, 'failed');
      throw error;
    }
  }

  private async changeGroupState(
    event: ContactTextEvent,
    query: string,
    action: 'disable' | 'unbind',
  ): Promise<RemoteInboundDisposition> {
    const matches = this.resolveContacts(query);
    if (matches.length !== 1) {
      return this.sendOwnerUsage(
        event,
        matches.length > 1
          ? 'Forge: multiple contacts match; use the short contact id.'
          : 'Forge: contact not found.',
      );
    }
    const changed =
      action === 'disable'
        ? await this.store.disable(matches[0]!.id)
        : await this.store.unbind(matches[0]!.id);
    await this.channel.send(
      event.chatId,
      changed ? `Forge: contact ${action}d.` : 'Forge: contact was not changed.',
      { signal: this.signal },
    );
    if (changed) this.onContactStateChanged?.(matches[0]!.id);
    return { kind: 'handled' };
  }

  private resolveContacts(query: string): RemoteContactRecord[] {
    const contacts = this.store.contacts(true);
    const byId = contacts.filter((contact) => contact.id === query || contact.id.startsWith(query));
    return byId.length > 0 ? byId : contactNameMatches(contacts, query);
  }

  private findByShortId(query: string, ids: string[]): string[] {
    return ids.filter((id) => id === query || id.startsWith(query));
  }

  private groupLinkResult(result: string): string {
    return result === 'confirmed'
      ? 'Forge: group linked. The approved contact can now chat in this private group.'
      : `Forge: group link could not be confirmed (${result}).`;
  }

  private sendOwnerUsage(event: ContactTextEvent, text: string): Promise<RemoteInboundDisposition> {
    return this.channel
      .send(event.chatId, text, { signal: this.signal })
      .then(() => ({ kind: 'rejected', reason: text }));
  }

  private notifyOwner(ownerId: string, text: string): Promise<void> {
    return this.channel.send(ownerId, text, { signal: this.signal }).then(() => undefined);
  }

  private async answerCallback(event: ContactActionEvent, text: string): Promise<void> {
    await this.channel
      .answerCallbackQuery?.(event.providerMessageId, text, { signal: this.signal })
      .catch(() => undefined);
  }

  private async finishCallback(event: ContactActionEvent, text: string): Promise<void> {
    await this.answerCallback(event, text);
    await this.channel
      .clearInlineKeyboard?.(event.chatId, event.messageId, { signal: this.signal })
      .catch(() => undefined);
  }

  private syntheticEvent(contact: RemoteContactRecord): ContactTextEvent {
    return {
      channel: 'telegram',
      kind: 'text',
      providerMessageId: `contact-${contact.id}`,
      senderId: contact.telegramUserId,
      chatId: contact.groupChatId ?? contact.telegramChatId,
      chatType: contact.groupChatId ? 'group' : 'private',
      receivedAt: Date.now(),
      text: '',
    };
  }
}
