import { randomUUID } from 'crypto';

export interface TurnReservation {
  readonly conversationId: string;
  readonly token: string;
}

export interface RequestChainContext {
  readonly conversationId: string;
  readonly userIntentEpoch: number;
  readonly reservation: TurnReservation;
  autoContinueCount: number;
  readonly remoteRequestId?: string;
}

export type TurnAdmissionResult =
  | { kind: 'reserved'; reservation: TurnReservation }
  | { kind: 'busy'; conversationId: string };

/**
 * Conversation-scoped ownership above individual model turns.
 *
 * `TurnLifecycle` still owns provider streaming and cancellation. This class
 * owns the logical user request that may span several turns through compaction
 * and continuation. All methods that mutate admission state are synchronous,
 * so one extension-host event cannot interleave a second reservation between
 * the busy check and the map write.
 */
export class RequestChainLifecycle {
  private readonly reservations = new Map<string, TurnReservation>();
  private readonly epochs = new Map<string, number>();

  reserve(conversationId: string, externallyBusy: () => boolean): TurnAdmissionResult {
    if (this.reservations.has(conversationId) || externallyBusy()) {
      return { kind: 'busy', conversationId };
    }
    const reservation: TurnReservation = { conversationId, token: randomUUID() };
    this.reservations.set(conversationId, reservation);
    return { kind: 'reserved', reservation };
  }

  /** Advance the epoch only after the caller has accepted this user intent. */
  accept(reservation: TurnReservation, remoteRequestId?: string): RequestChainContext {
    this.assertOwner(reservation);
    const userIntentEpoch = (this.epochs.get(reservation.conversationId) ?? 0) + 1;
    this.epochs.set(reservation.conversationId, userIntentEpoch);
    return {
      conversationId: reservation.conversationId,
      userIntentEpoch,
      reservation,
      autoContinueCount: 0,
      ...(remoteRequestId ? { remoteRequestId } : {}),
    };
  }

  release(reservation: TurnReservation): void {
    const current = this.reservations.get(reservation.conversationId);
    if (current?.token === reservation.token) this.reservations.delete(reservation.conversationId);
  }

  currentEpoch(conversationId: string): number {
    return this.epochs.get(conversationId) ?? 0;
  }

  isCurrent(context: RequestChainContext): boolean {
    return this.currentEpoch(context.conversationId) === context.userIntentEpoch;
  }

  isReserved(conversationId: string): boolean {
    return this.reservations.has(conversationId);
  }

  private assertOwner(reservation: TurnReservation): void {
    const current = this.reservations.get(reservation.conversationId);
    if (current?.token !== reservation.token) {
      throw new Error(
        `Forge: request-chain reservation was lost for ${reservation.conversationId}.`,
      );
    }
  }
}
