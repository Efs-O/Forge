import * as os from 'os';
import type { ForgeConfig } from '../config/types';
import { DEFAULT_COPILOT_MODEL } from '../config/agentBusSchema';
import type { CopilotAcpSession } from '../agents/CopilotAcpSession';
import { copilotMeshPreamble } from '../agentBus/busContent';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';
import { registerAlias } from './aliasRegistry';
import { CopilotOwnedAdapter } from './adapters';
import { beginCreation, defaultCopilotFactory, type OwnedCopilotFactory } from './creationPreamble';
import type { MeshAdapter } from './meshAdapter';
import type { HostLivenessDeps } from './hostIdentity';
import {
  isForeignLiveOwner,
  readOwnership,
  recordConfirmedId,
  releaseClaim,
  writeOwnership,
} from './ownership';

/**
 * The Forge-owned GitHub Copilot CLI sessions (P2). Extracted from
 * `sessionProvider.ts` (at the 500-line lint limit) the same way the Codex and
 * Claude owned paths share `creationPreamble`. One warm
 * `copilot --acp --stdio --no-remote --allow-all` child per alias, addressed
 * by its confirmed ACP session id.
 *
 * The module owns the in-memory session map and the single async creation
 * path (creation lease, one-time consent). The `MeshSessionProvider` keeps the
 * record-based operations (park/wake/isParked/touchActivity/isOwner) and the
 * `close` method (ownership check + record clear + delegate dispose).
 */

export interface CopilotOwnedDeps extends HostLivenessDeps {
  busRoot: string;
  getConfig: () => ForgeConfig;
  workspaceRoots: () => string[];
  /** Injectable for tests; production spawns a real ACP child. */
  copilotFactory?: OwnedCopilotFactory;
  /** Called when a session RESUME fails (M3): a visible `context_lost` event. */
  onContextLost?: (alias: string, reason: string) => void;
}

export class CopilotOwnedSessions {
  private readonly owned = new Map<string, CopilotAcpSession>();
  private readonly creating = new Map<string, Promise<MeshAdapter | { error: string }>>();
  /** Aliases currently being disposed by TTL/recovery. */
  private readonly reaping = new Set<string>();
  /**
   * Sessions created fresh (no prior confirmed id) that have not yet received
   * their one-time creation prompt. A resumed session already knows its
   * identity, so it is never added here.
   */
  private readonly needsPreamble = new WeakSet<CopilotAcpSession>();

  constructor(private readonly deps: CopilotOwnedDeps) {}

  /** Whether this window holds an in-memory Copilot session for the alias. */
  isOwned(alias: string): boolean {
    return this.owned.has(alias.trim().toLowerCase());
  }

  /**
   * Resolve the adapter for an alias: an in-memory owned session, else a
   * resume/creation (M3). A session another LIVE window owns is never
   * re-spawned here (M2) — that window is responsible for the alias.
   */
  async resolveAdapter(alias: string): Promise<MeshAdapter | undefined> {
    const a = alias.trim().toLowerCase();
    if (this.reaping.has(a)) return undefined;
    const existing = this.owned.get(a);
    if (existing) return this.adapter(a, existing);
    const rec = readOwnership(this.deps.busRoot, a);
    if (rec?.owner_host && this.isForeignLiveOwner(rec.owner_host)) return undefined;
    const result = await this.ensureOwned(a);
    return 'error' in result ? undefined : result;
  }

  /**
   * Ensure an owned Copilot session for the alias, creating or resuming (M3)
   * as needed. The single async creation path. Idempotent: a concurrent call
   * for the same alias awaits the same in-flight creation.
   */
  ensureOwned(alias: string): Promise<MeshAdapter | { error: string }> {
    const a = alias.trim().toLowerCase();
    if (this.reaping.has(a))
      return Promise.resolve({ error: `owned ${a} session is being reaped; try again shortly` });
    const existing = this.owned.get(a);
    if (existing) return Promise.resolve(this.adapter(a, existing));
    const inflight = this.creating.get(a);
    if (inflight) return inflight;
    const promise = this.createOwned(a).finally(() => this.creating.delete(a));
    this.creating.set(a, promise);
    return promise;
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
      const session = this.owned.get(a);
      if (!session) return;
      this.owned.delete(a);
      await session.dispose();
    } finally {
      this.reaping.delete(a);
    }
  }

  /**
   * Dispose the in-memory session for an alias (the provider's `close` calls
   * this after its ownership check + record clear). Returns the session that
   * was disposed, or undefined when this window did not hold one.
   */
  async disposeSession(alias: string): Promise<void> {
    const a = alias.trim().toLowerCase();
    const session = this.owned.get(a);
    if (!session) return;
    this.owned.delete(a);
    await session.dispose();
  }

  /** Dispose all in-memory owned sessions (window shutdown). */
  async dispose(): Promise<void> {
    const sessions = [...this.owned.values()];
    this.owned.clear();
    await Promise.all(sessions.map((s) => s.dispose()));
  }

  private adapter(alias: string, s: CopilotAcpSession): CopilotOwnedAdapter {
    return new CopilotOwnedAdapter(
      s,
      () => recordConfirmedId(this.deps.busRoot, alias, s.confirmedSessionId, this.deps),
      () => this.takePreamble(s),
    );
  }

  /** The one-time creation prompt for a freshly-created session (no prior id).
   *  Consumed exactly once; a resumed session (never added) gets none. */
  private takePreamble(s: CopilotAcpSession): string | undefined {
    if (!this.needsPreamble.has(s)) return undefined;
    this.needsPreamble.delete(s);
    return copilotMeshPreamble();
  }

  private isForeignLiveOwner(owner: { pid: number; startedAt: number }): boolean {
    return isForeignLiveOwner(this.deps, owner);
  }

  private async createOwned(alias: string): Promise<MeshAdapter | { error: string }> {
    const start = await beginCreation(
      this.deps.busRoot,
      alias,
      (o) => this.isForeignLiveOwner(o),
      this.deps,
    );
    // Copilot has no non-observing fallback (no `copilot queue`, no peer pipe),
    // so a foreign live owner means this window cannot reach the session.
    if (start.kind === 'join') return { error: `another window owns the ${alias} session` };
    if (start.kind === 'refuse') return { error: start.error };
    const { host, rec, aliasRec } = start;
    const sessionId = rec?.session_id ?? aliasRec?.session_id;
    try {
      const bus = this.deps.getConfig().agent_bus;
      const factory = this.deps.copilotFactory ?? defaultCopilotFactory();
      // Injected factories are already test doubles; resolving a real CLI
      // before calling them makes the deterministic mesh tests depend on the
      // host having Copilot installed. Production still resolves the
      // configured executable through the default factory path.
      const executable = this.deps.copilotFactory
        ? (bus?.copilot_cli ?? 'copilot')
        : await resolveCliExecutable(bus?.copilot_cli ?? 'copilot', 'copilot');
      const session = await factory.create({
        alias,
        sessionId,
        executable,
        cwd: this.deps.workspaceRoots()[0] ?? os.homedir(),
        model: bus?.copilot_model ?? DEFAULT_COPILOT_MODEL,
      });
      const newSessionId = session.confirmedSessionId ?? sessionId;
      this.owned.set(alias, session);
      // A fresh creation (no prior confirmed id) announces itself once; a
      // resume already knows its identity.
      if (!sessionId) this.needsPreamble.add(session);
      writeOwnership(this.deps.busRoot, {
        alias,
        agent: 'copilot',
        session_id: newSessionId ?? '',
        owner_host: host,
        workspace: this.deps.workspaceRoots()[0] ?? '',
        created_at: Date.now(),
        parked: false,
      });
      if (!aliasRec) {
        registerAlias(
          this.deps.busRoot,
          alias,
          {
            agent: 'copilot',
            session_id: newSessionId ?? '',
            registered_at: Date.now(),
            by: 'forge',
          },
          this.deps,
        );
      }
      return this.adapter(alias, session);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      // M3: a failed RESUME (a prior session existed) is a visible context
      // loss — the plan never swaps in a fresh session silently. A fresh
      // creation failing (no prior session) is just a creation error.
      if (sessionId && this.deps.onContextLost) this.deps.onContextLost(alias, why);
      return { error: `could not create the owned ${alias} session: ${why}` };
    } finally {
      releaseClaim(this.deps.busRoot, alias);
    }
  }
}
