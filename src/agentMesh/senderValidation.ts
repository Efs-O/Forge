import { inRoots, pickClaudePeer, readClaudeSessions } from '../agentBus/claudePeer';
import type { ForgeConfig } from '../config/types';
import { getAlias } from './aliasRegistry';
import { codexPinIsLive } from './codexPinLiveness';

export type SenderValidation = { ok: true } | { ok: false; error: string };

/**
 * Validate an inbound sender. Registered aliases are stable identities; a
 * deprecated config pin is accepted only after its target is proven live.
 */
export async function validateInboundSender(
  from: string,
  baseValidate: (from: string) => SenderValidation,
  root: string,
  getConfig: () => ForgeConfig,
  workspaceRoot: string,
  knownAliases: () => string[],
): Promise<SenderValidation> {
  const alias = from.trim().toLowerCase();
  const bus = getConfig().agent_bus;
  const liveList = (): string =>
    knownAliases()
      .filter((known) => known !== alias)
      .join(', ') || 'none';
  // A registered alias wins over a deprecated pin. Only the pin-only fallback
  // needs an asynchronous liveness proof (F-05).
  if (alias === 'codex' && bus?.codex_thread && !getAlias(root, 'codex')) {
    const live = await codexPinIsLive(bus.codex_thread, {
      ...(bus.codex_cli ? { codexCli: bus.codex_cli } : {}),
      cwd: workspaceRoot || process.cwd(),
    });
    return live
      ? { ok: true }
      : { ok: false, error: `unknown sender "${from}"; live aliases: ${liveList()}` };
  }
  // §10: "claude" is a live sender whenever a Claude Code session is open in
  // this workspace (the endpoint token already proves a local caller). A stale
  // pin name no longer refuses it; that refusal is what made users rename.
  if (alias === 'claude' && !getAlias(root, 'claude')) {
    const roots = workspaceRoot ? [workspaceRoot] : [];
    const sessions = readClaudeSessions();
    const live =
      !('error' in pickClaudePeer(sessions, { pin: bus?.claude_session }, roots)) ||
      sessions.some((s) => !s.sdk && inRoots(s.cwd, roots));
    return live
      ? { ok: true }
      : { ok: false, error: `unknown sender "${from}"; live aliases: ${liveList()}` };
  }
  return baseValidate(from);
}
