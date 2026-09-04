import type { RemoteInboundEvent } from './types';

/**
 * How long a held prompt stays replayable. Long enough to fetch a phone and
 * open an authenticator, short enough that a prompt abandoned mid-thought does
 * not run hours later against a workspace that has moved on.
 */
const DEFAULT_TTL_MS = 10 * 60_000;

/**
 * Only text events are ever held. That is structural, not a rule to remember:
 * gate() blocks every non-text event before the challenge branch is reachable.
 */
export type RemoteTextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;

interface HeldPrompt {
  event: RemoteTextEvent;
  heldAt: number;
}

/**
 * The one held prompt per chat, kept while its sender clears the TOTP
 * challenge and replayed once they do.
 *
 * Holding is safe because identity is settled before the gate: a non-owner is
 * rejected in RemoteController.handle() and again inside RemoteSessionAuth.gate()
 * when the enrolled owner does not match. A held prompt is therefore provably
 * the owner's, with only the second factor outstanding -- and it runs only once
 * that factor is satisfied.
 *
 * Memory-only, matching the sessions it shadows: a window reload drops both.
 */
export class RemotePendingPrompt {
  private readonly held = new Map<string, HeldPrompt>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  /** Holds one prompt, replacing any older one for the same chat. */
  hold(event: RemoteTextEvent, now = Date.now()): void {
    this.held.set(key(event.channel, event.chatId), { event, heldAt: now });
  }

  /** Pops the held prompt, or undefined when there is none or it has aged out. */
  take(
    channel: RemoteInboundEvent['channel'],
    chatId: string,
    now = Date.now(),
  ): RemoteTextEvent | undefined {
    const mapKey = key(channel, chatId);
    const entry = this.held.get(mapKey);
    if (!entry) return undefined;
    this.held.delete(mapKey);
    return now - entry.heldAt > this.ttlMs ? undefined : entry.event;
  }

  clear(channel: RemoteInboundEvent['channel'], chatId: string): void {
    this.held.delete(key(channel, chatId));
  }

  clearChannel(channel: RemoteInboundEvent['channel']): void {
    for (const mapKey of [...this.held.keys()]) {
      if (mapKey.startsWith(`${channel}:`)) this.held.delete(mapKey);
    }
  }
}

/** Short, single-line echo so a replayed prompt is never silent. */
export function previewPrompt(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > 120 ? `"${flat.slice(0, 120)}…"` : `"${flat}"`;
}

function key(channel: RemoteInboundEvent['channel'], chatId: string): string {
  return `${channel}:${chatId}`;
}
