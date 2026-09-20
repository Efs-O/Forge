import {
  listAliases,
  registerAlias,
  resolveSessionIdentity,
  type AgentKind,
} from './aliasRegistry';
import { AliasFifo, type FifoEvent } from './aliasFifo';
import type { ExchangeState } from './deliveryState';
import { newEventId } from './exchangeLog';
import type { MeshAdapter } from './meshAdapter';
import type { HostLivenessDeps } from './hostIdentity';
import type { MeshCommand } from './meshCommands';

/**
 * The agent-mesh orchestrator (AGENT_MESH_PLAN §1, §4, M6, M7). The single
 * entry point for sending a message to an agent and for relaying an inbound
 * bus message to its final recipient.
 *
 * It owns: alias resolution (§4), the per-alias FIFOs (M5), the board-event
 * writer (wired to the exchange log), and the host-side relay (M6). It does
 * **not** own the owned-session lifecycle — that is the SessionProvider,
 * supplied by the wiring (the window that owns the stdio pipe, M2).
 *
 * The relay (M6) is host-side and addressed: when an inbound message names a
 * `to` that is not Forge, the host forwards it through the recipient's adapter
 * with **zero Forge model turns**. A relayed message cannot be relayed again
 * (hop count ≤ 2 per exchange).
 */

export interface SessionProvider {
  /**
   * Return the adapter for an alias, creating a Forge-owned session if needed
   * (consent is the tool's confirmation gate for `tell`; an inbound relay
   * only ever reaches an already-consented alias). Resolving may be async
   * (a first owned creation or a thread resume). Returns undefined when no
   * adapter can be resolved (no alias, no live pin, no owned session).
   */
  resolveAdapter(alias: string): Promise<MeshAdapter | undefined>;
  /** Whether this alias has a live, owned session this window holds. */
  isOwned(alias: string): boolean;
  /**
   * Whether the alias's adapter observes turns (F-03). A non-observing alias
   * stays `accepted` until a verdict appears, so the exchange id is bound into
   * the message so the agent's verdict can be correlated.
   */
  isObserving(alias: string): boolean;
  /** F-07: record activity on the alias's owned session (the idle-TTL clock). */
  touchActivity(alias: string): void;
  /** Standby: park-but-warm (§2b). True when a record was parked. */
  park(alias: string): boolean;
  /** Wake a parked session (§2b). True when a record was woken. */
  wake(alias: string): boolean;
  /** Is the alias parked? (the board's `parked` state, §2b.) */
  isParked(alias: string): boolean;
  /**
   * Close: hard-kill a Forge-owned session (§8). Disposes the in-memory
   * session (if held) and clears `owner_host`; keeps `thread_id` (M3). Never
   * targets a user-opened session (no ownership record). True when closed.
   */
  close(alias: string): Promise<boolean>;
}

export interface MeshScope {
  workspace: string;
  conversation?: string;
}

export interface TellOutcome {
  exchangeId: string;
  /** The recipient alias the message was accepted for. */
  to: string;
  /** True when the recipient is an owned session (states will reach `started`). */
  observing: boolean;
}

export interface RelayOutcome extends TellOutcome {
  /** The two hop events share this exchange id (M6). */
  relayed: true;
}

export interface OrchestratorDeps extends HostLivenessDeps {
  busRoot: string;
  provider: SessionProvider;
  scope: () => MeshScope;
  /**
   * Write a board event (wired to the exchange log by the wiring layer).
   * F-03: must be durable before the tell/relay result is returned, so the
   * accepted state is on disk before the caller is told the exchange exists.
   */
  onEvent: (e: {
    exchangeId: string;
    from: string;
    to?: string;
    type: string;
    state: ExchangeState;
    detail?: string;
  }) => Promise<void> | void;
  /**
   * The set of known aliases (registered + the live config pins). Used to
   * validate a relay's `to` and to report the live list on an unknown `to`.
   */
  knownAliases: () => string[];
  /**
   * F-03: the outbox dir where a non-observing agent writes its verdict
   * (`<exchangeId>.verdict.md`). Passed to the adapter so it can bind the
   * exchange id to the verdict instruction; the wiring polls it to complete
   * the exchange.
   */
  verdictDir?: string;
  /**
   * F-09: render an observational command (status/board/peers/queue/context)
   * into a reply string. The wiring layer knows the scope and board projection,
   * so it renders; the orchestrator dispatches. Absent ⇒ the command reports
   * that the host has no board (the placeholder is preserved).
   */
  onObservation?: (verb: 'status' | 'board' | 'peers' | 'queue' | 'context') => string;
}

export class MeshOrchestrator {
  private readonly fifos = new Map<string, AliasFifo>();
  private readonly host = 'forge';

  constructor(private readonly deps: OrchestratorDeps) {}

  /**
   * The in-memory FIFO for an alias, created on first use (M5). Single-flight:
   * two concurrent first-use calls for the same alias must install ONE FIFO,
   * or the second would start a turn while the first is active (M5 violation).
   * The `creating` map dedupes the in-flight resolution.
   */
  private readonly creating = new Map<string, Promise<AliasFifo | undefined>>();

  private async fifoFor(alias: string): Promise<AliasFifo | undefined> {
    const existing = this.fifos.get(alias);
    if (existing) return existing;
    const inflight = this.creating.get(alias);
    if (inflight) return inflight;
    const promise = (async () => {
      const adapter = await this.deps.provider.resolveAdapter(alias);
      if (!adapter) return undefined;
      // Re-check: a concurrent call may have installed it while we resolved.
      const installed = this.fifos.get(alias);
      if (installed) return installed;
      const fifo = new AliasFifo(adapter, {
        // F-03: propagate the promise so the FIFO's `await` on the durable
        // `accepted` is real — the event is on disk before the caller is told
        // the message was accepted.
        onEvent: (e: FifoEvent) =>
          this.deps.onEvent({
            exchangeId: e.exchangeId,
            from: this.host,
            to: alias,
            type: 'state',
            state: e.state,
            ...(e.detail ? { detail: e.detail } : {}),
          }),
      });
      this.fifos.set(alias, fifo);
      return fifo;
    })().finally(() => this.creating.delete(alias));
    this.creating.set(alias, promise);
    return promise;
  }

  /**
   * Forge-originated send (the `tell_live_session` path). Resolves the
   * recipient, enqueues through its FIFO, and returns at once (no wait).
   */
  async tell(to: string, message: string): Promise<TellOutcome | { error: string }> {
    const alias = to.trim().toLowerCase();
    if (!this.isKnownAlias(alias)) {
      return {
        error: `unknown recipient "${to}"; live aliases: ${this.deps.knownAliases().join(', ') || 'none'}`,
      };
    }
    // F-06: an ordinary send also wakes a parked session (§2b), so the durable
    // parked record does not lag the new active turn.
    if (this.deps.provider.isParked(alias)) this.deps.provider.wake(alias);
    const fifo = await this.fifoFor(alias);
    if (!fifo) {
      return { error: `no live session for "${to}" (no alias, no live pin, no owned session)` };
    }
    const exchangeId = newEventId();
    // F-03: a non-observing recipient (a user-opened session) cannot be
    // observed directly, so the exchange id is bound into the message. The
    // agent's verdict file is named `<exchangeId>.verdict.md`, which the
    // wiring polls to complete the exchange (an exchange-correlated verdict,
    // not a transport exit code).
    const outbound = this.deps.provider.isObserving(alias)
      ? message
      : `${message}\n\n[forge: when you finish this, write your verdict to outbox/${exchangeId}.verdict.md]`;
    // F-03: the FIFO's `accepted` is the durable acknowledgement — awaited so
    // it is on disk before we return the exchange id.
    const res = await fifo.enqueue({ exchangeId, message: outbound });
    if (!res.accepted) {
      return { error: `queue full for "${to}" (${res.queueLength}); message rejected` };
    }
    // F-07: a message just went to this session; refresh its idle-TTL clock.
    this.deps.provider.touchActivity(alias);
    return { exchangeId, to: alias, observing: this.deps.provider.isOwned(alias) };
  }

  /**
   * F-06: a steer. Interrupts the recipient's active turn (so it resolves as
   * `cancelled` and the FIFO advances) and queues the steer to run next, before
   * any ordinary queued message. Wakes a parked session first (§2b).
   */
  async steer(to: string, message: string): Promise<TellOutcome | { error: string }> {
    const alias = to.trim().toLowerCase();
    if (!this.isKnownAlias(alias)) {
      return {
        error: `unknown recipient "${to}"; live aliases: ${this.deps.knownAliases().join(', ') || 'none'}`,
      };
    }
    if (this.deps.provider.isParked(alias)) this.deps.provider.wake(alias);
    const fifo = await this.fifoFor(alias);
    if (!fifo) {
      return { error: `no live session for "${to}" (no alias, no live pin, no owned session)` };
    }
    const exchangeId = newEventId();
    // F-03: the FIFO's `accepted` is the durable acknowledgement (awaited).
    const res = await fifo.steer({ exchangeId, message });
    if (!res.accepted) {
      return { error: `queue full for "${to}" (${res.queueLength}); steer rejected` };
    }
    this.deps.provider.touchActivity(alias);
    return { exchangeId, to: alias, observing: this.deps.provider.isOwned(alias) };
  }

  /**
   * The host-side relay (M6). An inbound bus message with `to` not equal to
   * Forge is forwarded by the host through the recipient's adapter — no Forge
   * model turn is spent, and the model does not decide whether to relay.
   *
   * Two hop events share one exchange id: the inbound hop (from the sender)
   * and the forwarded hop (to the recipient). A relayed message cannot be
   * relayed again (`hops` ≥ 2 is refused).
   */
  async relay(
    from: string,
    to: string,
    message: string,
    hops = 0,
  ): Promise<RelayOutcome | { error: string }> {
    if (hops >= 2) {
      return { error: 'refusing to relay a relay (hop count exceeded)' };
    }
    const recipient = to.trim().toLowerCase();
    if (!this.isKnownAlias(recipient)) {
      return {
        error: `unknown recipient "${to}"; live aliases: ${this.deps.knownAliases().join(', ') || 'none'}`,
      };
    }
    const fifo = await this.fifoFor(recipient);
    if (!fifo) {
      return { error: `no live session for "${to}"` };
    }
    const exchangeId = newEventId();
    // Hop 1: the inbound message, as received. F-03: durable before the relay
    // result is returned.
    await this.deps.onEvent({
      exchangeId,
      from,
      to: this.host,
      type: 'relay',
      state: 'accepted',
      detail: 'inbound bus message',
    });
    const res = await fifo.enqueue({ exchangeId, message });
    if (!res.accepted) {
      return { error: `queue full for "${to}" (${res.queueLength}); relay rejected` };
    }
    // F-07: a relayed message just reached this session; refresh its TTL clock.
    this.deps.provider.touchActivity(recipient);
    // Hop 2: the host's forward to the recipient (idempotent `accepted`).
    await this.deps.onEvent({
      exchangeId,
      from: this.host,
      to: recipient,
      type: 'relay',
      state: 'accepted',
      detail: 'host relay',
    });
    return {
      exchangeId,
      to: recipient,
      observing: this.deps.provider.isOwned(recipient),
      relayed: true,
    };
  }

  /**
   * §4: an unknown `from` is rejected with the live list. A human-readable
   * name is never the sole identity — resolution is by alias.
   */
  validateFrom(from: string): { ok: true } | { ok: false; error: string } {
    const alias = from.trim().toLowerCase();
    if (alias === this.host) return { ok: true };
    if (this.isKnownAlias(alias)) return { ok: true };
    return {
      ok: false,
      error: `unknown sender "${from}"; live aliases: ${this.deps.knownAliases().join(', ') || 'none'}`,
    };
  }

  /** Register an alias (one-time, consented). */
  registerAlias(alias: string, agent: AgentKind, sessionId: string, by: 'user' | 'forge'): void {
    registerAlias(this.deps.busRoot, alias, {
      agent,
      session_id: sessionId,
      registered_at: Date.now(),
      by,
    });
  }

  /** The live aliases: registered ones plus the config pins. */
  private isKnownAlias(alias: string): boolean {
    if (alias === this.host) return true;
    return this.deps.knownAliases().includes(alias);
  }

  /** All known aliases (for the board's "peers" view). */
  aliases(): string[] {
    return this.deps.knownAliases();
  }

  /** Registered alias records (the board's "peers" detail). */
  registeredAliases() {
    return listAliases(this.deps.busRoot);
  }

  /** Resolve an alias's session identity (alias over pin, §0). */
  resolveIdentity(alias: string, pin: string | undefined) {
    return resolveSessionIdentity(this.deps.busRoot, alias, pin);
  }

  /** The current scope (workspace + conversation) for board events. */
  scope(): MeshScope {
    return this.deps.scope();
  }

  /** The workspace root, for path-relative board scoping. */
  workspacePath(): string {
    return this.deps.scope().workspace;
  }

  /** Dispose all FIFOs (window shutdown). */
  dispose(): void {
    for (const fifo of this.fifos.values()) fifo.dispose();
    this.fifos.clear();
  }

  /** The pending (queued-but-unsent) message count for an alias (§7). */
  queueLength(alias: string): number {
    return this.fifos.get(alias.trim().toLowerCase())?.pending ?? 0;
  }

  /**
   * Dispatch a typed lifecycle command (§8, P3). The single owner of the
   * command grammar is `meshCommands.ts`; this method supplies the handlers.
   * Returns the reply string (what the caller shows the sender).
   */
  async handleCommand(cmd: MeshCommand): Promise<string> {
    switch (cmd.verb) {
      case 'say': {
        const res = await this.tell(cmd.alias, cmd.message);
        return 'error' in res ? res.error : `sent to ${res.to} (exchange ${res.exchangeId})`;
      }
      case 'steer': {
        // F-06: a steer interrupts the active turn and runs next (§6/§2b).
        const message = cmd.message.trim()
          ? cmd.message
          : 'steer: interrupt the current work and report status';
        const res = await this.steer(cmd.alias, message);
        return 'error' in res ? res.error : `steered ${res.to} (exchange ${res.exchangeId})`;
      }
      case 'standby': {
        const ok = this.deps.provider.park(cmd.alias);
        return ok
          ? `${cmd.alias} parked (warm; the thread stays resumable)`
          : `no session to park for "${cmd.alias}"`;
      }
      case 'wake': {
        const ok = this.deps.provider.wake(cmd.alias);
        return ok ? `${cmd.alias} woken` : `no parked session for "${cmd.alias}"`;
      }
      case 'handoff': {
        const message = cmd.context.trim()
          ? `handoff: my part is done. ${cmd.context}`
          : 'handoff: my part is done; you take over.';
        const res = await this.tell(cmd.alias, message);
        return 'error' in res ? res.error : `handed off to ${res.to} (exchange ${res.exchangeId})`;
      }
      case 'close': {
        const ok = await this.deps.provider.close(cmd.alias);
        return ok
          ? `${cmd.alias} closed (Forge-owned session killed; thread kept for resume)`
          : `"${cmd.alias}" is not a Forge-owned session (never closes a user-opened session)`;
      }
      default:
        // F-09: observational commands render real scoped state through the
        // wiring layer's projection. Without a renderer installed, the
        // placeholder is preserved (the grammar stays complete).
        if (this.deps.onObservation) return this.deps.onObservation(cmd.verb);
        return `"${cmd.verb}" is handled by the host (scope + board)`;
    }
  }
}
