import * as os from 'os';
import type { ForgeConfig } from '../config/types';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';
import type { ClaudeOwnedSession } from '../agents/ClaudeOwnedSession';
import { pickClaudePeer, readClaudeSessions, type ClaudeSession } from '../agentBus/claudePeer';
import { getAlias, joinedPeer, type AliasRecord } from './aliasRegistry';
import { ClaudeOwnedAdapter, ClaudePeerAdapter } from './adapters';
import {
  defaultClaudeFactory,
  defaultSendClaude,
  type OwnedClaudeFactory,
} from './creationPreamble';
import type { MeshAdapter } from './meshAdapter';

/**
 * The joined Claude peer, and the stand-in that answers while it is dead
 * (CLAUDE_STAND_IN_RESUME_PLAN §3).
 *
 * A joined session (`forge.sh join claude`) stops on a VS Code reload and stays
 * stopped until its panel opens. A stand-in then resumes that conversation
 * headless (`--resume <claude_session_id>`), so the answer lands in the joined
 * session's own history, and `onStandIn` tells the user it happened.
 *
 * A stand-in is NOT an owned session: it never enters the provider's owned
 * map, and nothing here writes an ownership or alias record. M3 resume,
 * recovery and the TTL reaper cannot see it, and the user's session id can
 * never leak into `ownership/claude.json`. It lives for one FIFO drain
 * (`onIdle`), until the joined peer is live again, or until provider dispose.
 */

export interface JoinedClaudeDeps {
  busRoot: string;
  getConfig: () => ForgeConfig;
  workspaceRoots: () => string[];
  /** Injectable for tests; production reads ~/.claude/sessions. */
  claudeSessions?: () => ClaudeSession[];
  /** Injectable for tests; production uses the configured transport. */
  sendClaude?: (session: ClaudeSession, message: string, signal?: AbortSignal) => Promise<void>;
  /** Injectable for tests; production spawns a real owned Claude stdio session. */
  claudeFactory?: OwnedClaudeFactory;
  /** Tells the user a stand-in answered for a dead joined session (plan §3.2). */
  onStandIn?: (alias: string, note: string) => void;
}

const DEAD =
  '⚠️ The Claude session the user joined is not running (a VS Code reload stops it until ' +
  'its panel is opened again)';

/** Shown to the agent with the result whenever a stand-in answers for a dead joined session. */
export function claudeStandInNote(resumeId: string | undefined): string {
  return resumeId
    ? `${DEAD}, so Forge resumed that conversation headless to answer; the answer is in ` +
        `its history. Tell the user: reopening that panel continues it there.`
    : `${DEAD}, so a Forge-owned Claude session answered instead. It does NOT have the ` +
        `context of the joined conversation (the join recorded no Claude session id). ` +
        `Tell the user, and that opening that panel and running \`forge.sh join claude\` ` +
        `there reconnects their own session.`;
}

/** The same event, addressed to the user (VS Code, Telegram) rather than to the agent. */
export function claudeStandInUserNote(resumeId: string | undefined): string {
  return resumeId
    ? `⚠️ Your Claude session was closed, so Forge answered for it headless. The answer is ` +
        `in that session's history; reopening its panel continues it.`
    : `⚠️ Your Claude session was closed, so a separate Forge-owned Claude answered without ` +
        `its context. Reopen that panel and run \`forge.sh join claude\` there to reconnect it.`;
}

export class JoinedClaude {
  private standIn: { session: ClaudeOwnedSession; adapter: MeshAdapter } | undefined;
  private creating: Promise<MeshAdapter | undefined> | undefined;
  /** Makes each stand-in's key unique, so the FIFO never reuses a disposed one. */
  private seq = 0;

  constructor(private readonly deps: JoinedClaudeDeps) {}

  /** The user-opened Claude session in this workspace (joined, pinned, or found). */
  peerAdapter(): MeshAdapter | undefined {
    const bus = this.deps.getConfig().agent_bus;
    // The stand-in resumes the joined session id, so its own process must
    // never be mistaken for the joined peer coming back.
    const standInPid = this.standIn?.session.pid;
    const sessions = (
      this.deps.claudeSessions ? this.deps.claudeSessions() : readClaudeSessions()
    ).filter((s) => standInPid === undefined || s.pid !== standInPid);
    const joined = joinedPeer(getAlias(this.deps.busRoot, 'claude'));
    const picked = pickClaudePeer(
      sessions,
      { joined, pin: bus?.claude_session },
      this.deps.workspaceRoots(),
    );
    if ('error' in picked) return undefined;
    const send = this.deps.sendClaude ?? defaultSendClaude(bus);
    return new ClaudePeerAdapter(picked.session, send);
  }

  /** A joined alias: the live peer while it runs, else a stand-in resuming its conversation. */
  async resolve(aliasRec: AliasRecord): Promise<MeshAdapter | undefined> {
    const live = this.peerAdapter();
    if (live) {
      await this.disposeStandIn();
      return live;
    }
    if (this.standIn) return this.standIn.adapter;
    this.creating ??= this.createStandIn(aliasRec.claude_session_id).finally(() => {
      this.creating = undefined;
    });
    return this.creating;
  }

  async dispose(): Promise<void> {
    await this.disposeStandIn();
  }

  private async createStandIn(resumeId: string | undefined): Promise<MeshAdapter | undefined> {
    const bus = this.deps.getConfig().agent_bus;
    let session: ClaudeOwnedSession;
    try {
      // Injected factories are test doubles; see createOwnedClaude.
      const executable = this.deps.claudeFactory
        ? (bus?.claude_cli ?? 'claude')
        : await resolveCliExecutable(bus?.claude_cli ?? 'claude', 'claude');
      session = await (this.deps.claudeFactory ?? defaultClaudeFactory()).create({
        alias: 'claude',
        sessionId: resumeId,
        executable,
        cwd: this.deps.workspaceRoots()[0] ?? os.homedir(),
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.deps.onStandIn?.('claude', `${DEAD}, and Forge could not start a stand-in: ${why}`);
      return undefined;
    }
    let forkReported = false;
    // A resume that comes back under a different id forked: say where the answer went.
    const inner = new ClaudeOwnedAdapter(session, () => {
      const id = session.confirmedSessionId;
      if (!resumeId || !id || id === resumeId || forkReported) return;
      forkReported = true;
      this.deps.onStandIn?.(
        'claude',
        `The Claude stand-in answered in a new session (${id}), not in the joined one ` +
          `(${resumeId}); that answer is not in the panel's history.`,
      );
    });
    const adapter: MeshAdapter = {
      kind: 'claude',
      observesTurns: true,
      key: `claude-stand-in:${resumeId ?? 'blank'}:${++this.seq}`,
      note: claudeStandInNote(resumeId),
      send: (message, options) => inner.send(message, options),
      interrupt: () => inner.interrupt(),
      onIdle: () =>
        void this.disposeStandIn(adapter).catch((err: unknown) =>
          this.deps.onStandIn?.(
            'claude',
            `The Claude stand-in did not stop cleanly: ${String(err)}`,
          ),
        ),
    };
    this.standIn = { session, adapter };
    this.deps.onStandIn?.('claude', claudeStandInUserNote(resumeId));
    return adapter;
  }

  /** Dispose the current stand-in; with `only`, only if it is still that one. */
  private async disposeStandIn(only?: MeshAdapter): Promise<void> {
    const current = this.standIn;
    if (!current || (only && current.adapter !== only)) return;
    this.standIn = undefined;
    await current.session.dispose();
  }
}
