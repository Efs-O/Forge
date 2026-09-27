import type { ForgeConfig } from '../config/types';
import type { CodexAppServerSession } from '../agents/CodexAppServerSession';
import { queueToCodex } from '../agentBus/codexDelivery';
import { getAlias } from './aliasRegistry';
import { JoinedClaude, type JoinedClaudeDeps } from './claudeStandIn';
import type { OwnedCodexFactory, OwnedCopilotFactory } from './creationPreamble';
import { CopilotOwnedSessions } from './copilotOwned';
import type { MeshAdapter } from './meshAdapter';
import type { HostLivenessDeps } from './hostIdentity';
import {
  isForeignLiveOwner,
  isOwnerOf,
  readOwnership,
  removeOwnership,
  writeOwnership,
} from './ownership';
import { OwnedSessionFactory } from './ownedSessionFactory';
import type { SessionProvider } from './meshOrchestrator';

/**
 * The session provider (AGENT_MESH_PLAN §0, M2, M3, §10). The window that owns
 * a Forge-owned session holds it in memory here, keyed by alias, and is the
 * only window that may reap it. Detect: a joined Claude session while live; a
 * live owned session; a registered alias/thread resumes (M3); an open Claude
 * session (non-observing). Create: otherwise Forge creates its own under the
 * creation lease (M2), `owner_host` = this window. Reap: `reap(alias)`
 * disposes the in-memory session (recovery, M2/M3).
 *
 * The owned-session CONSTRUCTION (the in-memory session maps, the create/ensure
 * path, the idle-release handles) lives in {@link OwnedSessionFactory} (Codex +
 * Claude) and {@link CopilotOwnedSessions} (Copilot), both extracted to keep
 * this file under the 500-line lint limit. This class keeps alias resolution,
 * the FIFO-facing orchestration, and the record-based lifecycle
 * (park/wake/reap/close/dispose), delegating the in-memory session work.
 */

export interface SessionProviderDeps extends HostLivenessDeps, JoinedClaudeDeps {
  busRoot: string;
  getConfig: () => ForgeConfig;
  workspaceRoots: () => string[];
  /** Injectable for tests; production runs `codex queue`. */
  queueCodex?: typeof queueToCodex;
  /** Injectable for tests; production spawns a real app-server. */
  codexFactory?: OwnedCodexFactory;
  /** Injectable for tests; production spawns a real ACP child. */
  copilotFactory?: OwnedCopilotFactory;
  /**
   * Called when a thread RESUME fails (M3): a failed resume is a visible
   * `context_lost` board event (a fresh creation failing is not a context loss).
   */
  onContextLost?: (alias: string, reason: string) => void;
}

export class MeshSessionProvider implements SessionProvider {
  /** Aliases currently being disposed by TTL/recovery. */
  private readonly reaping = new Set<string>();
  /** The joined peer and its stand-in (never an owned session). */
  private readonly joined: JoinedClaude;
  private readonly copilotOwned: CopilotOwnedSessions;
  /** The owned Codex + Claude session construction (in-memory maps + create/ensure). */
  private readonly factory: OwnedSessionFactory;

  constructor(private readonly deps: SessionProviderDeps) {
    this.joined = new JoinedClaude(deps);
    this.copilotOwned = new CopilotOwnedSessions(deps);
    this.factory = new OwnedSessionFactory({
      ...deps,
      claudePeerAdapter: () => this.joined.peerAdapter(),
    });
  }

  /** The in-memory owned session for an alias, if this window holds it. */
  getOwned(alias: string): CodexAppServerSession | undefined {
    return this.factory.getOwnedCodex(alias);
  }

  isOwned(alias: string): boolean {
    return this.factory.isOwned(alias) || this.copilotOwned.isOwned(alias);
  }

  /**
   * The owned Claude creation path (M3): create or resume. Public so a caller
   * (and the P4 test) can drive creation directly and observe the creation
   * error. Distinct from {@link resolveAdapter}, which also handles the
   * join/stand-in/peer fallbacks and returns `undefined` (not an error) when a
   * foreign window owns the session.
   */
  ensureOwnedClaude(alias: string): Promise<MeshAdapter | { error: string }> {
    return this.factory.ensureOwnedClaude(alias);
  }

  /**
   * F-07: record activity on the alias's ownership record (the idle-TTL
   * reaper's clock). Called when a message is sent to an owned session, so a
   * busy session is never reaped while in use. Parked sessions are exempt from
   * the TTL (park-but-warm), so this is a no-op for them.
   */
  touchActivity(alias: string): void {
    const a = alias.trim().toLowerCase();
    const rec = readOwnership(this.deps.busRoot, a);
    if (!rec) return;
    writeOwnership(this.deps.busRoot, { ...rec, last_activity: Date.now() });
  }

  /**
   * Resolve the adapter for an alias, in the order the class comment gives.
   * Undefined when none can be reached or created. May create a Forge-owned
   * session, so it is async.
   */
  async resolveAdapter(alias: string): Promise<MeshAdapter | undefined> {
    const a = alias.trim().toLowerCase();
    if (this.reaping.has(a)) return undefined;
    if (a === 'claude') return this.claudeAdapterAsync();
    if (a === 'codex') return this.codexAdapterAsync();
    if (a === 'copilot') return this.copilotOwned.resolveAdapter(a);
    return undefined;
  }

  /**
   * The async Codex path: an in-memory owned session, else a resume/creation
   * (M3). The config pin is used only when another window owns the session.
   */
  private async codexAdapterAsync(): Promise<MeshAdapter | undefined> {
    await this.factory.waitCodexIdle('codex');
    const existing = this.factory.getOwnedCodex('codex');
    if (existing) return this.factory.codexOwnedAdapter('codex', existing);
    const rec = readOwnership(this.deps.busRoot, 'codex');
    // M2: a session another LIVE window owns is never re-spawned here (that
    // window serializes the alias's turns; a second app-server would race its
    // resume/send path). Fall back to a user-opened queue session, else none.
    if (rec?.owner_host && this.isForeignLiveOwner(rec.owner_host)) {
      return this.factory.codexAdapterIfLive();
    }
    // A registered alias or prior thread resumes (M3); with neither, Forge
    // creates its own. Not the config pin: `codex queue` only reaches a thread
    // open in a Codex window, and "live" there only proves it exists on disk.
    const result = await this.factory.ensureOwnedCodex('codex');
    return 'error' in result ? undefined : result;
  }

  /**
   * True when `owner` is a live host that is NOT this one. `isHostAlive` is
   * true for self, so the pid comparison separates "I own it" (resume is safe)
   * from "another window owns it" (never race it).
   */
  private isForeignLiveOwner(owner: { pid: number; startedAt: number }): boolean {
    return isForeignLiveOwner(this.deps, owner);
  }

  /**
   * True when THIS window is the live owner of the alias's record (F-02). Only
   * the owner may mutate parked/close the record or reap it: a peer window that
   * cleared another window's `owner_host` would orphan the live stdio pipe and
   * let a later message spawn a second pipe on the same alias. Public so the
   * maintenance loop can reap only sessions it owns.
   */
  isOwner(alias: string): boolean {
    const rec = readOwnership(this.deps.busRoot, alias);
    if (!rec?.owner_host) return false;
    return isOwnerOf(this.deps, rec.owner_host);
  }

  /**
   * The async Claude path (P4, §10): a joined session, an owned stdio session,
   * a resume (M3), an open session in this workspace (the sync
   * `claudeAdapter`), else a new Forge-owned one.
   */
  private async claudeAdapterAsync(): Promise<MeshAdapter | undefined> {
    const aliasRec = getAlias(this.deps.busRoot, 'claude');
    // A joined session (`forge.sh join`) wins while live. A dead one (a reload
    // stops it) gets a stand-in that resumes its conversation, never silently.
    if (aliasRec?.peer_pid !== undefined) return this.joined.resolve(aliasRec);
    const existing = this.factory.getOwnedClaude('claude');
    if (existing) return this.factory.claudeOwnedAdapter('claude', existing);
    const rec = readOwnership(this.deps.busRoot, 'claude');
    // M2: a session another LIVE window owns is never re-spawned here. This
    // window does not hold its stdio pipe, so it cannot drive it; a second
    // owned Claude would leave two live pipes on one alias. Fall back to the
    // user-opened peer/relay (non-observing).
    if (rec?.owner_host && this.isForeignLiveOwner(rec.owner_host)) {
      return this.joined.peerAdapter();
    }
    // A prior owned session resumes (M3). Otherwise an open session in this
    // workspace (non-observing), else Forge creates its own.
    if (rec?.session_id || (aliasRec && aliasRec.peer_pid === undefined)) {
      const result = await this.factory.ensureOwnedClaude('claude');
      return 'error' in result ? undefined : result;
    }
    const peer = this.joined.peerAdapter();
    if (peer) return peer;
    const created = await this.factory.ensureOwnedClaude('claude');
    return 'error' in created ? undefined : created;
  }

  /**
   * Reap the in-memory owned session for an alias (owner-host-death recovery,
   * M2/M3). The ownership record's `owner_host` is cleared by the caller
   * (recoverOwnership); the resume identity is kept for the next creation.
   */
  async reap(alias: string): Promise<void> {
    const a = alias.trim().toLowerCase();
    if (this.reaping.has(a)) return;
    this.reaping.add(a);
    try {
      const copilot = this.copilotOwned.isOwned(a);
      await this.factory.reapInMemory(a);
      if (copilot) await this.copilotOwned.reap(a);
    } finally {
      this.reaping.delete(a);
    }
  }

  /**
   * Standby: park-but-warm (§2b, P3). Sets `parked: true` on the ownership
   * record (durable: survives a restart, and exempts the session from the idle
   * TTL while parked, M4). The thread stays resumable; an idle Codex process is
   * released after its FIFO drains. `undefined` when the alias has no ownership
   * record (nothing to park).
   */
  park(alias: string): boolean {
    const a = alias.trim().toLowerCase();
    const rec = readOwnership(this.deps.busRoot, a);
    if (!rec) return false;
    // F-02: only the live owner may mutate the record. A peer window parking
    // another window's session would corrupt the ownership it does not hold.
    if (rec.owner_host && !this.isOwner(a)) return false;
    writeOwnership(this.deps.busRoot, { ...rec, parked: true });
    return true;
  }

  /** Wake a parked session (§2b). Clears `parked`; `undefined` when no record. */
  wake(alias: string): boolean {
    const a = alias.trim().toLowerCase();
    const rec = readOwnership(this.deps.busRoot, a);
    if (!rec) return false;
    // F-02: owner-only mutation (a peer window must not wake a session it does not hold).
    if (rec.owner_host && !this.isOwner(a)) return false;
    writeOwnership(this.deps.busRoot, { ...rec, parked: false });
    return true;
  }

  /** Is the alias parked? (The board's `parked` state, §2b.) */
  isParked(alias: string): boolean {
    return readOwnership(this.deps.busRoot, alias.trim().toLowerCase())?.parked === true;
  }

  /**
   * Close: hard-kill a Forge-owned session (§8, P3). Disposes the in-memory
   * session (if this window holds it) and clears `owner_host` on the record.
   * The `thread_id` is kept (M3: a later `say`/`steer` resumes the same thread).
   * **Never** targets a user-opened session: a user-opened session has no
   * ownership record, so there is nothing to kill here. `undefined` when the
   * alias has no ownership record.
   */
  async close(alias: string): Promise<boolean> {
    const a = alias.trim().toLowerCase();
    const rec = readOwnership(this.deps.busRoot, a);
    if (!rec) return false;
    // F-02: only the live owner may close. A peer window that cleared another
    // window's `owner_host` would orphan the live stdio pipe (the process keeps
    // running with no owner record, and a later message spawns a second pipe on
    // the same alias). Refuse: the owner window must close its own session.
    if (rec.owner_host && !this.isOwner(a)) return false;
    await this.factory.closeInMemory(a);
    await this.copilotOwned.disposeSession(a);
    writeOwnership(this.deps.busRoot, {
      ...rec,
      owner_host: null,
      parked: false,
    });
    return true;
  }

  /** Yield an idle Forge-owned Codex alias to an interactive Codex join. */
  async releaseForCodexJoin(): Promise<boolean> {
    const rec = readOwnership(this.deps.busRoot, 'codex');
    if (rec?.owner_host && !this.isOwner('codex')) return false;
    await this.factory.closeInMemory('codex');
    removeOwnership(this.deps.busRoot, 'codex');
    return true;
  }

  /** Dispose all in-memory owned sessions (window shutdown). */
  async dispose(): Promise<void> {
    await Promise.all([
      this.factory.disposeAll(),
      this.joined.dispose(),
      this.copilotOwned.dispose(),
    ]);
  }
}
