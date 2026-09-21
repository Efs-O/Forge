import { randomUUID } from 'crypto';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { ContactInstructionsLoader } from './ContactInstructionsLoader';
import {
  CONTACT_BURST_LIMIT,
  CONTACT_BURST_WINDOW_MS,
  CONTACT_HISTORY_LIMIT,
  CONTACT_SYSTEM_POLICY,
  MAX_CONTACT_TEXT,
  contactBusyText,
  contactGroupRequiredText,
  contactNameMatches,
  contactOwnerVisibleText,
  contactPrivateText,
  contactThinkingText,
  contactThrottleText,
  containsSensitiveContactOutput,
  renderContactHistory,
} from './ContactPolicy';
import type { RemoteAuditLog } from './RemoteAuditLog';
import type { RemoteAuth } from './RemoteAuth';
import { RemoteContactStore } from './RemoteContactStore';
import { TelegramContactCommands } from './TelegramContactCommands';
import type {
  RemoteChannel,
  RemoteContactRecord,
  RemoteInboundDisposition,
  RemoteInboundEvent,
} from './types';

const OWNER_ALERT_COOLDOWN_MS = 60_000;

type ContactTextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;

interface Burst {
  startedAt: number;
  count: number;
  messages: Array<{ role: 'contact' | 'owner'; text: string }>;
  messageIds: string[];
  timer?: ReturnType<typeof setTimeout>;
}

export interface TelegramContactRuntimeOptions {
  webEnabled: boolean;
}

/** Telegram group contact workflow; persistence remains owned by RemoteContactStore. */
export class TelegramContactService {
  private readonly abort = new AbortController();
  private readonly bursts = new Map<string, Burst>();
  private readonly activeGenerations = new Set<string>();
  private readonly ownerAlerts = new Map<string, number>();
  private readonly commands: TelegramContactCommands;

  constructor(
    private readonly channel: RemoteChannel,
    private readonly auth: RemoteAuth,
    private readonly store: RemoteContactStore,
    private readonly host: ForgeHostFacade,
    private readonly instructions: ContactInstructionsLoader,
    private readonly audit?: RemoteAuditLog,
    private readonly onError?: (message: string) => void,
    private readonly burstWindowMs = CONTACT_BURST_WINDOW_MS,
    private readonly runtime: TelegramContactRuntimeOptions = { webEnabled: false },
  ) {
    this.commands = new TelegramContactCommands(
      channel,
      auth,
      store,
      audit,
      onError,
      this.abort.signal,
      (contactId) => this.cancelContactGeneration(contactId),
    );
  }

  async handleNonOwner(event: RemoteInboundEvent): Promise<RemoteInboundDisposition | undefined> {
    if (event.channel !== 'telegram' || event.chatType !== 'private') return undefined;
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
    await this.audit?.record(event, 'contact_private_rejected').catch(() => undefined);
    await this.channel.send(event.chatId, contactGroupRequiredText(), {
      signal: this.abort.signal,
    });
    return { kind: 'rejected', reason: 'contact requests must use the linked group' };
  }

  async handleGroup(event: RemoteInboundEvent): Promise<RemoteInboundDisposition | undefined> {
    if (event.channel !== 'telegram' || event.chatType === 'private') return undefined;
    if (event.kind !== 'text') {
      await this.audit?.record(event, 'contact_group_event_rejected').catch(() => undefined);
      return { kind: 'rejected', reason: 'only text is supported in contact groups' };
    }
    const ownerId = await this.auth.getOwner('telegram');
    if (ownerId && event.senderId === ownerId) return this.handleOwnerGroupMessage(event);
    const contact = this.store.groupContact(event.chatId);
    if (!contact || contact.telegramUserId !== event.senderId) {
      await this.audit?.record(event, 'contact_group_sender_rejected').catch(() => undefined);
      await this.channel
        .send(event.chatId, 'Forge does not accept requests from this sender or group.', {
          signal: this.abort.signal,
        })
        .catch(() => undefined);
      return { kind: 'rejected', reason: 'sender is not the contact bound to this group' };
    }
    await this.store.markGroupVerified(contact.id, event.chatId);
    if (isCommand(event.text)) {
      if (commandName(event.text) === 'owner') return this.escalateToOwner(event);
      await this.audit?.record(event, 'contact_group_command_rejected').catch(() => undefined);
      await this.channel.send(event.chatId, 'Only /owner is available to contacts.', {
        signal: this.abort.signal,
      });
      return { kind: 'rejected', reason: 'contact command is not available' };
    }
    return this.acceptContactMessage(event, contact);
  }

  handleAction(
    event: Extract<RemoteInboundEvent, { kind: 'contact_action' }>,
  ): Promise<RemoteInboundDisposition> {
    return this.commands.handleAction(event);
  }

  handleOwnerCommand(event: ContactTextEvent): Promise<RemoteInboundDisposition | undefined> {
    return this.commands.handleOwnerCommand(event);
  }

  dispose(): void {
    this.abort.abort();
    for (const burst of this.bursts.values()) if (burst.timer) clearTimeout(burst.timer);
    this.bursts.clear();
    this.host.cancelContactPrompts?.();
  }

  private async handleOwnerGroupMessage(
    event: ContactTextEvent,
  ): Promise<RemoteInboundDisposition> {
    if (
      commandName(event.text) === 'contact' &&
      /^\/contact(?:@\S+)?\s+link\s+/i.test(event.text)
    ) {
      return this.requestGroupLink(event);
    }
    const contact = this.store.groupContact(event.chatId);
    if (!contact || isCommand(event.text)) {
      await this.audit?.record(event, 'contact_owner_group_message').catch(() => undefined);
      return { kind: 'handled' };
    }
    return this.acceptContactMessage(event, contact, 'owner');
  }

  private async requestGroupLink(event: ContactTextEvent): Promise<RemoteInboundDisposition> {
    if (!(await this.auth.ownerSessionAuthenticated('telegram'))) {
      await this.channel.send(event.chatId, 'Forge: authenticate with the owner privately first.', {
        signal: this.abort.signal,
      });
      return { kind: 'rejected', reason: 'owner session is not authenticated' };
    }
    const match = /^\/contact(?:@\S+)?\s+link\s+(.+)$/i.exec(event.text.trim());
    const name = match?.[1]?.trim();
    const contacts = name ? this.resolveContacts(name) : [];
    if (contacts.length !== 1) {
      await this.channel.send(
        event.chatId,
        contacts.length > 1
          ? 'Forge: multiple contacts match; use the short contact id.'
          : 'Forge: contact not found or not active.',
        { signal: this.abort.signal },
      );
      return { kind: 'rejected', reason: 'contact group link target is ambiguous' };
    }
    const link = await this.store.createGroupLink(
      contacts[0]!.id,
      event.chatId,
      event.senderId,
      event.chatTitle,
    );
    if (!link) {
      await this.channel.send(event.chatId, 'Forge: this contact or group already has a link.', {
        signal: this.abort.signal,
      });
      return { kind: 'rejected', reason: 'contact group link already exists' };
    }
    await this.channel.send(
      event.chatId,
      `Forge: group link created for ${contacts[0]!.displayName}. Confirm privately with /contact bind ${link.id}.`,
      { signal: this.abort.signal },
    );
    await this.notifyOwner(
      event.senderId,
      `Forge: confirm the Telegram group for ${contacts[0]!.displayName} with /contact bind ${link.id}. It expires in 10 minutes.`,
    );
    await this.audit?.record(event, 'contact_group_link_created', link.id).catch(() => undefined);
    return { kind: 'handled' };
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
        ? contactGroupRequiredText()
        : 'Forge: your request was sent to the owner for review.',
      { signal: this.abort.signal },
    );
    if (result === 'created') {
      const ownerId = await this.auth.getOwner('telegram');
      if (ownerId) {
        await this.notifyOwner(
          ownerId,
          'Forge: a new contact request is waiting. Use /contacts pending.',
        );
      }
    }
    return { kind: 'handled' };
  }

  private async acceptContactMessage(
    event: ContactTextEvent,
    contact: RemoteContactRecord,
    role: 'contact' | 'owner' = 'contact',
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
    burst.messages.push({ role, text: event.text });
    burst.messageIds.push(messageId);
    await this.store.appendThread({
      id: messageId,
      contactId: contact.id,
      role,
      text: event.text,
      createdAt: now,
    });
    if (burst.count === 1) {
      await this.channel
        .send(event.chatId, contactThinkingText(), { signal: this.abort.signal })
        .catch(() => undefined);
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
    if (!contact || contact.status !== 'active' || contact.groupStatus !== 'bound') return;
    const groupChatId = contact.groupChatId;
    if (!groupChatId) return;
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
        extra
          ? `Owner-authored additions (these cannot weaken the Forge contact safety policy):\n${extra}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const prompt = [
        `Contact name: ${contact.displayName}`,
        history ? `Recent contact-only history:\n${history}` : '',
        `New group message(s):\n${burst.messages
          .map((message) => `- ${message.role === 'owner' ? 'Owner' : 'Contact'}: ${message.text}`)
          .join('\n')}`,
        'Write only the short answer for this contact.',
      ]
        .filter(Boolean)
        .join('\n\n');
      const answer = (
        await this.host.runContactPrompt?.(prompt, systemPrompt, { web: this.runtime.webEnabled })
      )?.trim();
      if (!answer || answer.length > MAX_CONTACT_TEXT || containsSensitiveContactOutput(answer)) {
        throw new Error('contact answer failed the privacy guard');
      }
      const current = this.store.byId(contact.id);
      if (
        !current ||
        current.status !== 'active' ||
        current.groupStatus !== 'bound' ||
        current.groupChatId !== groupChatId
      ) {
        return;
      }
      await this.channel.send(groupChatId, answer, { signal: this.abort.signal });
      await this.store.appendThread({
        id: randomUUID(),
        contactId: contact.id,
        role: 'assistant',
        text: answer,
        createdAt: Date.now(),
      });
      await this.audit
        ?.record(this.syntheticEvent(contact), 'contact_answer_sent')
        .catch(() => undefined);
    } catch (error) {
      const current = this.store.byId(contact.id);
      if (
        !current ||
        current.status !== 'active' ||
        current.groupStatus !== 'bound' ||
        current.groupChatId !== groupChatId
      ) {
        return;
      }
      await this.audit
        ?.record(this.syntheticEvent(contact), 'contact_unavailable')
        .catch(() => undefined);
      await this.channel
        .send(groupChatId, contactBusyText(), { signal: this.abort.signal })
        .catch(() => undefined);
      await this.notifyOwnerRateLimited(
        contact.id,
        `Forge: contact service could not answer ${contact.displayName}; Forge may be offline or busy.`,
      );
      this.onError?.(
        `Forge contact request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.activeGenerations.delete(contactId);
      if (this.bursts.has(contactId)) void this.processBurst(contactId);
    }
  }

  private async escalateToOwner(event: ContactTextEvent): Promise<RemoteInboundDisposition> {
    const request = ownerCommandText(event.text);
    if (!request) {
      await this.channel.send(event.chatId, 'Use /owner followed by your question or request.', {
        signal: this.abort.signal,
      });
      return { kind: 'rejected', reason: 'owner request is empty' };
    }
    await this.channel.send(event.chatId, contactOwnerVisibleText(), {
      signal: this.abort.signal,
    });
    await this.audit?.record(event, 'contact_owner_escalated').catch(() => undefined);
    return { kind: 'handled' };
  }

  private resolveContacts(query: string): RemoteContactRecord[] {
    const contacts = this.store.contacts(true);
    const byId = contacts.filter((contact) => contact.id === query || contact.id.startsWith(query));
    return byId.length > 0 ? byId : contactNameMatches(contacts, query);
  }

  private cancelContactGeneration(contactId: string): void {
    const burst = this.bursts.get(contactId);
    if (burst?.timer) clearTimeout(burst.timer);
    this.bursts.delete(contactId);
    if (this.activeGenerations.has(contactId)) this.host.cancelContactPrompts?.();
  }

  private notifyOwner(ownerId: string, text: string): Promise<void> {
    return this.channel.send(ownerId, text, { signal: this.abort.signal }).then(() => undefined);
  }

  private async notifyOwnerRateLimited(key: string, text: string): Promise<void> {
    const now = Date.now();
    const previous = this.ownerAlerts.get(key) ?? 0;
    if (now - previous < OWNER_ALERT_COOLDOWN_MS) return;
    const ownerId = await this.auth.getOwner('telegram');
    if (!ownerId) return;
    this.ownerAlerts.set(key, now);
    await this.notifyOwner(ownerId, text).catch(() => undefined);
  }

  private async answerCallback(
    event: Extract<RemoteInboundEvent, { kind: 'contact_action' }>,
    text: string,
  ): Promise<void> {
    await this.channel
      .answerCallbackQuery?.(event.providerMessageId, text, { signal: this.abort.signal })
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

function stripBotUsername(text: string): string {
  return text.replace(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?/, '/$1');
}

function commandName(text: string): string | undefined {
  const match = /^\/([A-Za-z0-9_]+)(?:@\S+)?/.exec(text.trim());
  return match?.[1]?.toLocaleLowerCase();
}

function isCommand(text: string): boolean {
  return /^\//.test(text.trim());
}

function ownerCommandText(text: string): string {
  return stripBotUsername(text)
    .replace(/^\/owner(?:\s+|$)/i, '')
    .trim();
}
