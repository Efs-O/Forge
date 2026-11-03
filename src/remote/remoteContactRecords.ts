/**
 * The records behind owner-approved remote contacts: who may speak to Forge
 * from a phone number, which group a contact is bound to, what an admitted
 * request has produced, and what the owner has sent outward.
 *
 * Split out of `types.ts` because that file is the one import site for the
 * remote surface and had reached the lint line limit again — the same reason
 * the inbound event contract lives in `remoteInboundSchema.ts` and is
 * re-exported from the barrel. These shapes depend on nothing but primitives,
 * so the split needs no imports and changes no import site.
 */

type RemoteContactStatus = 'active' | 'disabled';
type RemoteContactGroupStatus = 'unbound' | 'link_pending' | 'bound';

export interface RemoteContactRecord {
  id: string;
  displayName: string;
  telegramChatId: string;
  telegramUserId: string;
  role: 'contact_only';
  status: RemoteContactStatus;
  groupStatus: RemoteContactGroupStatus;
  groupChatId?: string | undefined;
  groupTitle?: string | undefined;
  groupBoundAt?: number | undefined;
  groupVerifiedAt?: number | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface RemoteContactGroupLinkRecord {
  id: string;
  contactId: string;
  groupChatId: string;
  groupTitle?: string | undefined;
  ownerId: string;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  state: 'pending' | 'confirmed' | 'cancelled' | 'expired';
}

export interface RemoteContactPendingRecord {
  id: string;
  telegramChatId: string;
  telegramUserId: string;
  createdAt: number;
  updatedAt: number;
  status: 'pending' | 'approved' | 'rejected';
}

/** Where an admitted contact request stands; see `RemoteContactStore.unfinished`. */
export type RemoteContactDisposition = 'pending' | 'running' | 'answered' | 'failed';

export interface RemoteContactThreadMessage {
  id: string;
  contactId: string;
  role: 'contact' | 'owner' | 'assistant';
  text: string;
  createdAt: number;
  /**
   * Inbound rows: `<channel>:<chatId>:<providerMessageId>`, so a redelivered
   * update is recognised rather than answered twice. Absent on assistant rows
   * and on rows written before it existed.
   */
  inboundKey?: string | undefined;
  /** Inbound rows: whether the request was answered. Survives a reload, unlike the burst timer. */
  disposition?: RemoteContactDisposition | undefined;
}

export type RemoteContactOutboundState =
  | 'pending'
  | 'confirmed'
  | 'cancelled'
  | 'expired'
  | 'sent'
  | 'failed';

export interface RemoteContactOutboundRecord {
  id: string;
  contactId: string;
  ownerId: string;
  ownerChatId: string;
  recipientChatId: string;
  recipientDisplayName: string;
  text: string;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  state: RemoteContactOutboundState;
}
