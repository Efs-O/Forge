/**
 * The sessions panel's row shapes, mirrored for host + webview.
 *
 * Kept out of `messageBridge.ts` the way `conversationMessages.ts` and
 * `jobPanelMessages.ts` are: the bridge sits at this repo's 500-line gate, and
 * it stays the single import for every message shape by re-exporting these.
 *
 * Both rows carry the same two provenance fields, because the panel badges an
 * open tab and a closed chat the same way: `title_source` is who named it and
 * `origin_agent` is who started it. They travel for one reason — a row cannot
 * tell an agent's brief from a person's sentence without them — and the webview
 * decides what to show from them, never the host.
 */
import type { TitleSource } from './conversationTitle';
import type { AgentLinks } from '../agentLinks/chatAgentLinks';
import type { RemoteOriginChannel } from '../remote/remoteInboundSchema';

/** Tab row mirrored for host + webview. */
export interface SessionTabMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  retention_activity_at?: number;
  keep_open?: boolean;
  messageCount?: number;
  active_model?: string;
  /** True while an agent turn is streaming in this conversation. */
  streaming?: boolean;
  /** Accumulated active-agent time for the tab badge. */
  active_time_ms?: number;
  agentLinks?: AgentLinks;
  /** Who named this chat; `user` means a person typed it and it is shown verbatim. */
  title_source?: TitleSource;
  /** Who started it, when an agent-bus prompt did — the sender name as the bus wrote it. */
  origin_agent?: string;
  /**
   * The remote chat this conversation is bound to, read from the binding list
   * the eviction gate already consults — not a field of the conversation, and
   * never written anywhere. It answers "did this chat arrive on a phone", and
   * the panel badges it Telegram or WhatsApp. A chat a person later picked with
   * `/chat` is bound too, so the badge says what is bound, not how it began.
   */
  origin_channel?: RemoteOriginChannel;
}

/** A chat the panel lists that has no open tab: recent history, or the overflow archive. */
export interface SessionHistoryMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  retention_activity_at?: number;
  keep_open?: boolean;
  messageCount?: number;
  active_model?: string;
  /** Accumulated active-agent time for the history badge. */
  active_time_ms?: number;
  /** Who named this chat; see `SessionTabMeta`. */
  title_source?: TitleSource;
  /** Who started it, when an agent-bus prompt did; see `SessionTabMeta`. */
  origin_agent?: string;
  /** The remote chat this closed chat is bound to; see `SessionTabMeta`. */
  origin_channel?: RemoteOriginChannel;
  /** Unchanged copy of the old global history; presentation only, never persisted. */
  legacy_global?: boolean;
}
