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
  /** Write a board event (wired to the exchange log by the wiring layer). */
  onEvent: (e: {
    exchangeId: string;
    from: string;
    to?: string;
    type: string;
    state: ExchangeState;
    detail?: string;
  }) => void;
  /**
   * The set of known aliases (registered + the live config pins). Used to
   * validate a relay's `to` and to report the live list on an unknown `to`.
   */
  knownAliases: () => string[];
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
        onEvent: (e: FifoEvent) => {
          this.deps.onEvent({
            exchangeId: e.exchangeId,
            from: this.host,
            to: alias,
            type: 'state',
            state: e.state,
            ...(e.detail ? { detail: e.detail } : {}),
          });
        },
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
    const fifo = await this.fifoFor(alias);
    if (!fifo) {
      return { error: `no live session for "${to}" (no alias, no live pin, no owned session)` };
    }
    const exchangeId = newEventId();
    const res = fifo.enqueue({ exchangeId, message });
    if (!res.accepted) {
      return { error: `queue full for "${to}" (${res.queueLength}); message rejected` };
    }
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
    // Hop 1: the inbound message, as received.
    this.deps.onEvent({
      exchangeId,
      from,
      to: this.host,
      type: 'relay',
      state: 'accepted',
      detail: 'inbound bus message',
    });
    const res = fifo.enqueue({ exchangeId, message });
    if (!res.accepted) {
      return { error: `queue full for "${to}" (${res.queueLength}); relay rejected` };
    }
    // Hop 2: the host's forward to the recipient.
    this.deps.onEvent({
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
}
