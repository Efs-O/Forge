import { randomUUID, randomBytes } from 'crypto';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { ContactInstructionsLoader } from './ContactInstructionsLoader';
import {
  CONTACT_BURST_LIMIT,
  CONTACT_BURST_WINDOW_MS,
  CONTACT_HISTORY_LIMIT,
  CONTACT_SYSTEM_POLICY,
  contactBusyText,
  contactThrottleText,
  contactNameMatches,
  contactPrivateText,
  contactThinkingText,
  containsSensitiveContactOutput,
  renderContactHistory,
} from './ContactPolicy';
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

const DRAFT_TTL_MS = 10 * 60_000;
const MAX_CONTACT_TEXT = 12_000;

type ContactTextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;
type ContactActionEvent = Extract<RemoteInboundEvent, { kind: 'contact_action' }>;

interface Burst {
  startedAt: number;
  count: number;
  messages: string[];
  messageIds: string[];
  timer?: ReturnType<typeof setTimeout>;
}

/** Telegram-only contact workflow; persistence remains owned by RemoteContactStore. */
export class TelegramContactService {
  private readonly abort = new AbortController();
  private readonly bursts = new Map<string, Burst>();
  private readonly activeGenerations = new Set<string>();

  constructor(
    private readonly channel: RemoteChannel,
    private readonly auth: RemoteAuth,
    private readonly store: RemoteContactStore,
    private readonly host: ForgeHostFacade,
    private readonly instructions: ContactInstructionsLoader,
    private readonly audit?: RemoteAuditLog,
    private readonly onError?: (message: string) => void,
    private readonly burstWindowMs = CONTACT_BURST_WINDOW_MS,
  ) {}

  async handleNonOwner(event: RemoteInboundEvent): Promise<RemoteInboundDisposition | undefined> {
    if (event.channel !== 'telegram') return undefined;
    if (event.kind === 'contact_action') {
      await this.audit?.record(event, 'contact_foreign_callback').catch(() => undefined);
      await this.answerCallback(event, contactPrivateText());
      return { kind: 'rejected', reason: 'contact callback is owner-only' };
    }
    if (event.kind !== 'text') return undefined;
    if (/^\/pair(?:\s|$)/i.test(event.text)) return undefined;
    if (event.text.trim() === '/start') return this.startRequest(event);
    const contact = this.store.byTelegram(event.senderId, event.chatId);
    if (!contact || contact.status !== 'active') {
      await this.audit?.record(event, 'contact_unknown_rejected').catch(() => undefined);
      await this.channel.send(event.chatId, contactPrivateText(), { signal: this.abort.signal });
      return { kind: 'rejected', reason: 'sender is not an approved contact' };
    }
    if (event.text.startsWith('/')) {
      await this.audit?.record(event, 'contact_command_rejected').catch(() => undefined);
      await this.channel.send(event.chatId, contactPrivateText(), { signal: this.abort.signal });
      return { kind: 'rejected', reason: 'contact commands are not available' };
    }
    return this.acceptContactMessage(event, contact);
  }

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
      await this.channel.send(draft.recipientChatId, draft.text, { signal: this.abort.signal });
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
        { signal: this.abort.signal },
      );
      return { kind: 'handled' };
    }
    if (/^\/contacts?\s+list$/i.test(text)) {
      const contacts = this.store.contacts(true);
      await this.channel.send(
        event.chatId,
        contacts.length === 0
          ? 'Forge: no active contacts.'
          : `Forge: active contacts:\n${contacts.map((item) => `- ${item.displayName} (${item.id.slice(0, 8)})`).join('\n')}`,
        { signal: this.abort.signal },
      );
      return { kind: 'handled' };
    }
    const approval = /^\/contact\s+approve\s+(\S+)\s+(.+)$/is.exec(text);
    if (approval) {
      const displayName = approval[2]!.trim();
      if (!displayName || displayName.length > 80) {
        return this.sendOwnerUsage(event, 'usage: /contact approve <pending-id> <display-name>');
      }
      const pending = this.findByShortId(
        approval[1]!,
        this.store.pending().map((item) => item.id),
      );
      if (!pending || pending.length !== 1)
        return this.sendOwnerUsage(event, 'usage: /contact approve <pending-id> <display-name>');
      const contact = await this.store.approve(pending[0]!, displayName);
      await this.channel.send(
        event.chatId,
        contact
          ? `Forge: contact approved as ${contact.displayName}.`
          : 'Forge: contact request is no longer pending.',
        { signal: this.abort.signal },
      );
      await this.audit
        ?.record(event, contact ? 'contact_approved' : 'contact_duplicate_rejected')
        .catch(() => undefined);
      return { kind: 'handled' };
    }
    const disable = /^\/contact\s+disable\s+(.+)$/is.exec(text);
    if (disable) {
      const matches = this.resolveContacts(disable[1]!.trim());
      if (matches.length !== 1) {
        return this.sendOwnerUsage(
          event,
          matches.length > 1
            ? 'Forge: multiple contacts match; use the short contact id.'
            : 'Forge: contact not found.',
        );
      }
      const disabled = await this.store.disable(matches[0]!.id);
      await this.channel.send(
        event.chatId,
        disabled ? 'Forge: contact disabled.' : 'Forge: contact was already disabled.',
        { signal: this.abort.signal },
      );
      await this.audit
        ?.record(event, disabled ? 'contact_disabled' : 'contact_disable_duplicate')
        .catch(() => undefined);
      return { kind: 'handled' };
    }
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
      await this.createAndPreview(matches[0]!, event.senderId, message, event);
      return { kind: 'handled' };
    }
    return this.sendOwnerUsage(
      event,
      'usage: /contacts pending|list, /contact approve|disable, or /send <name>: <message>',
    );
  }

  dispose(): void {
    this.abort.abort();
    for (const burst of this.bursts.values()) if (burst.timer) clearTimeout(burst.timer);
    this.bursts.clear();
    this.host.cancelContactPrompts?.();
  }

  private async startRequest(event: ContactTextEvent): Promise<RemoteInboundDisposition> {
    const result = await this.store.createPending(event.senderId, event.chatId);
    await this.audit
      ?.record(
        event,
        result === 'created' ? 'contact_pending_registered' : 'contact_pending_duplicate',
      )
      .catch(() => undefined);
    await this.channel.send(
      event.chatId,
      result === 'contact'
        ? 'Forge: contact access is already enabled.'
        : 'Forge: your request was sent to the owner for review.',
      { signal: this.abort.signal },
    );
    if (result === 'created') {
      const ownerId = await this.auth.getOwner('telegram');
      if (ownerId)
        await this.notifyOwner(
          ownerId,
          'Forge: a new contact request is waiting. Use /contacts pending.',
        );
    }
    return { kind: 'handled' };
  }

  private async acceptContactMessage(
    event: ContactTextEvent,
    contact: RemoteContactRecord,
  ): Promise<RemoteInboundDisposition> {
    if (event.text.length > MAX_CONTACT_TEXT) {
      await this.channel.send(event.chatId, contactBusyText(), { signal: this.abort.signal });
      return { kind: 'rejected', reason: 'contact message exceeds the limit' };
    }
    const now = Date.now();
    let burst = this.bursts.get(contact.id);
    if (!burst || now - burst.startedAt >= this.burstWindowMs) {
      if (burst?.timer) clearTimeout(burst.timer);
      burst = { startedAt: now, count: 0, messages: [], messageIds: [] };
      this.bursts.set(contact.id, burst);
    }
    if (burst.count >= CONTACT_BURST_LIMIT) {
      await this.audit?.record(event, 'contact_throttled').catch(() => undefined);
      await this.channel.send(event.chatId, contactThrottleText(), { signal: this.abort.signal });
      return { kind: 'handled' };
    }
    burst.count += 1;
    const messageId = randomUUID();
    burst.messages.push(event.text);
    burst.messageIds.push(messageId);
    await this.store.appendThread({
      id: messageId,
      contactId: contact.id,
      role: 'contact',
      text: event.text,
      createdAt: now,
    });
    if (burst.count === 1) {
      await this.channel
        .send(event.chatId, contactThinkingText(), { signal: this.abort.signal })
        .catch(() => undefined);
      const ownerId = await this.auth.getOwner('telegram');
      if (ownerId) {
        await this.notifyOwner(
          ownerId,
          `Forge: ${contact.displayName} sent a contact request; preparing a draft.`,
        ).catch(() => undefined);
      }
    }
    if (burst.timer) clearTimeout(burst.timer);
    const delay = Math.max(0, burst.startedAt + this.burstWindowMs - Date.now());
    burst.timer = setTimeout(() => void this.processBurst(contact.id), delay);
    await this.audit
      ?.record(event, burst.count === 1 ? 'contact_request_accepted' : 'contact_request_coalesced')
      .catch(() => undefined);
    return { kind: 'handled' };
  }

  private async processBurst(contactId: string): Promise<void> {
    const burst = this.bursts.get(contactId);
    if (!burst) return;
    this.bursts.delete(contactId);
    if (this.activeGenerations.has(contactId)) {
      this.bursts.set(contactId, burst);
      burst.timer = setTimeout(() => void this.processBurst(contactId), 1_000);
      return;
    }
    const contact = this.store.byId(contactId);
    if (!contact || contact.status !== 'active') return;
    this.activeGenerations.add(contactId);
    try {
      const history = renderContactHistory(
        this.store
          .thread(contactId, CONTACT_HISTORY_LIMIT + burst.messageIds.length)
          .filter((message) => !burst.messageIds.includes(message.id)),
      );
      const extra = this.instructions.load();
      const systemPrompt = [
        CONTACT_SYSTEM_POLICY,
        extra ? `Owner-authored additions:\n${extra}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const prompt = [
        `Contact name: ${contact.displayName}`,
        history ? `Recent contact-only history:\n${history}` : '',
        `New contact message(s):\n${burst.messages.map((message) => `- ${message}`).join('\n')}`,
        'Write only the short answer draft for this contact.',
      ]
        .filter(Boolean)
        .join('\n\n');
      const answer = (await this.host.runContactPrompt?.(prompt, systemPrompt))?.trim();
      if (!answer || answer.length > MAX_CONTACT_TEXT || containsSensitiveContactOutput(answer)) {
        throw new Error('contact answer failed the privacy guard');
      }
      const ownerId = await this.auth.getOwner('telegram');
      if (!ownerId) throw new Error('contact owner is unavailable');
      await this.createAndPreview(contact, ownerId, answer);
    } catch (error) {
      await this.audit
        ?.record(this.syntheticEvent(contact), 'contact_unavailable')
        .catch(() => undefined);
      await this.channel
        .send(contact.telegramChatId, contactBusyText(), { signal: this.abort.signal })
        .catch(() => undefined);
      this.onError?.(
        `Forge contact request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.activeGenerations.delete(contactId);
      if (this.bursts.has(contactId)) void this.processBurst(contactId);
    }
  }

  private async createAndPreview(
    contact: RemoteContactRecord,
    ownerId: string,
    text: string,
    source?: ContactTextEvent,
  ): Promise<void> {
    if (!text || text.length > MAX_CONTACT_TEXT)
      throw new Error('contact message exceeds the limit');
    const sendInlineKeyboard = this.channel.sendInlineKeyboard;
    if (!sendInlineKeyboard) throw new Error('contact approval transport is unavailable');
    const now = Date.now();
    const draft: RemoteContactOutboundRecord = {
      id: randomBytes(18).toString('base64url'),
      contactId: contact.id,
      ownerId,
      ownerChatId: ownerId,
      recipientChatId: contact.telegramChatId,
      recipientDisplayName: contact.displayName,
      text,
      createdAt: now,
      expiresAt: now + DRAFT_TTL_MS,
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
        `Ready to send to ${contact.displayName}:\n\n${text}`,
        [
          [
            { text: 'Send', callbackData: `c:${draft.id}:s` },
            { text: 'Cancel', callbackData: `c:${draft.id}:c` },
          ],
        ],
        { signal: this.abort.signal },
      );
      await this.audit
        ?.record(source ?? this.syntheticEvent(contact), 'contact_owner_previewed', draft.id)
        .catch(() => undefined);
    } catch (error) {
      await this.store.setState(draft.id, 'failed');
      throw error;
    }
  }

  private resolveContacts(query: string): RemoteContactRecord[] {
    const contacts = this.store.contacts(true);
    const byId = contacts.filter((contact) => contact.id === query || contact.id.startsWith(query));
    return byId.length > 0 ? byId : contactNameMatches(contacts, query);
  }

  private findByShortId(query: string, ids: string[]): string[] {
    return ids.filter((id) => id === query || id.startsWith(query));
  }

  private sendOwnerUsage(event: ContactTextEvent, text: string): Promise<RemoteInboundDisposition> {
    return this.channel
      .send(event.chatId, text, { signal: this.abort.signal })
      .then(() => ({ kind: 'rejected', reason: text }));
  }

  private notifyOwner(ownerId: string, text: string): Promise<void> {
    return this.channel.send(ownerId, text, { signal: this.abort.signal }).then(() => undefined);
  }

  private async answerCallback(event: ContactActionEvent, text: string): Promise<void> {
    await this.channel
      .answerCallbackQuery?.(event.providerMessageId, text, { signal: this.abort.signal })
      .catch(() => undefined);
  }

  private async finishCallback(event: ContactActionEvent, text: string): Promise<void> {
    await this.answerCallback(event, text);
    await this.channel
      .clearInlineKeyboard?.(event.chatId, event.messageId, { signal: this.abort.signal })
      .catch(() => undefined);
  }

  private syntheticEvent(contact: RemoteContactRecord): ContactTextEvent {
    return {
      channel: 'telegram',
      kind: 'text',
      providerMessageId: `contact-${contact.id}`,
      senderId: contact.telegramUserId,
      chatId: contact.telegramChatId,
      chatType: 'private',
      receivedAt: Date.now(),
      text: '',
    };
  }
}
