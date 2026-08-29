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

export type RequestChainStage =
  | 'reserved'
  | 'running'
  | 'evaluating'
  | 'compacting'
  | 'continuing'
  | 'cancelling'
  | 'settling';

export interface RequestChainStatus {
  conversationId: string;
  userIntentEpoch: number;
  stage: RequestChainStage;
  managed: boolean;
  remoteRequestId?: string;
}

interface ActiveChain {
  context: RequestChainContext;
  stage: RequestChainStage;
  managedPromise?: Promise<unknown>;
  terminationKind?: 'cancelled' | 'interrupted';
  continuationSuppressed?: boolean;
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
  private readonly chains = new Map<string, ActiveChain>();

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
    const context: RequestChainContext = {
      conversationId: reservation.conversationId,
      userIntentEpoch,
      reservation,
      autoContinueCount: 0,
      ...(remoteRequestId ? { remoteRequestId } : {}),
    };
    this.chains.set(reservation.conversationId, { context, stage: 'reserved' });
    return context;
  }

  /** Own the complete request promise, including post-turn work and settlement. */
  async run<T>(context: RequestChainContext, task: () => Promise<T>): Promise<T> {
    const active = this.assertContext(context);
    if (active.managedPromise) {
      throw new Error(`Forge: request chain ${context.conversationId} is already running.`);
    }
    active.stage = 'running';
    const managed = Promise.resolve().then(task);
    active.managedPromise = managed;
    try {
      return await managed;
    } finally {
      const current = this.chains.get(context.conversationId);
      if (current === active) {
        current.stage = 'settling';
        delete current.managedPromise;
      }
      this.release(context.reservation);
    }
  }

  setStage(context: RequestChainContext, stage: RequestChainStage): void {
    this.assertContext(context).stage = stage;
  }

  markCancelling(
    conversationId: string,
    terminationKind: 'cancelled' | 'interrupted' = 'cancelled',
  ): void {
    const active = this.chains.get(conversationId);
    if (active) {
      active.stage = 'cancelling';
      active.terminationKind = terminationKind;
    }
  }

  terminationKind(context: RequestChainContext): 'cancelled' | 'interrupted' | undefined {
    return this.assertContext(context).terminationKind;
  }

  suppressContinuation(conversationId: string): void {
    const active = this.chains.get(conversationId);
    if (active) active.continuationSuppressed = true;
  }

  isContinuationSuppressed(context: RequestChainContext): boolean {
    return this.assertContext(context).continuationSuppressed === true;
  }

  release(reservation: TurnReservation): void {
    const current = this.reservations.get(reservation.conversationId);
    if (current?.token !== reservation.token) return;
    this.reservations.delete(reservation.conversationId);
    this.chains.delete(reservation.conversationId);
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

  status(conversationId?: string): RequestChainStatus[] {
    const active = conversationId
      ? [this.chains.get(conversationId)].filter((chain): chain is ActiveChain => !!chain)
      : [...this.chains.values()];
    return active.map(({ context, stage, managedPromise }) => ({
      conversationId: context.conversationId,
      userIntentEpoch: context.userIntentEpoch,
      stage,
      managed: managedPromise !== undefined,
      ...(context.remoteRequestId ? { remoteRequestId: context.remoteRequestId } : {}),
    }));
  }

  /**
   * Release only with positive evidence that no owner can still mutate state.
   * Elapsed time is intentionally absent: a slow model is not an orphan.
   */
  reconcile(
    conversationId: string,
    evidence: { providerBusy: boolean; backgroundBusy: boolean },
  ): boolean {
    const active = this.chains.get(conversationId);
    if (
      !active ||
      active.managedPromise ||
      evidence.providerBusy ||
      evidence.backgroundBusy ||
      (active.stage !== 'settling' && active.stage !== 'cancelling')
    ) {
      return false;
    }
    this.release(active.context.reservation);
    return true;
  }

  private assertOwner(reservation: TurnReservation): void {
    const current = this.reservations.get(reservation.conversationId);
    if (current?.token !== reservation.token) {
      throw new Error(
        `Forge: request-chain reservation was lost for ${reservation.conversationId}.`,
      );
    }
  }

  private assertContext(context: RequestChainContext): ActiveChain {
    this.assertOwner(context.reservation);
    const active = this.chains.get(context.conversationId);
    if (active?.context !== context || !this.isCurrent(context)) {
      throw new Error(`Forge: request chain is stale for ${context.conversationId}.`);
    }
    return active;
  }
}
