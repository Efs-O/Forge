import { randomUUID } from 'crypto';
import * as path from 'path';
import { CodexDiscovery } from '../agentMesh/codexDiscovery';
import { readClaudeSessions } from '../agentBus/claudePeer';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';
import type { ForgeConfig } from '../config/types';
import type { AgentKind } from './chatAgentLinks';

export interface AgentTarget {
  targetId: string;
  agent: AgentKind;
  kind: 'new_task' | 'existing_session';
  title: string;
  cwd: string;
  sessionId?: string;
  /** Existing sessions have unknown model/effort; never infer them from a title. */
  model?: string;
  effort?: string;
}

const TTL_MS = 10 * 60_000;
const MAX_CHATS = 128;
const MAX_TARGETS = 2048;
interface Snapshot {
  cwd: string;
  expiresAt: number;
  targets: readonly AgentTarget[];
}

/** Memory-only capabilities: a target belongs to one chat, folder and discovery. */
export class AgentTargetCatalog {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly pinned = new WeakMap<
    object,
    { chatId: string; cwd: string; target: AgentTarget }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  publish(
    chatId: string,
    cwd: string,
    targets: readonly Omit<AgentTarget, 'targetId'>[],
  ): AgentTarget[] {
    this.prune();
    this.snapshots.delete(chatId);
    if (targets.length > MAX_TARGETS)
      throw new Error('Too many CLI targets; discovery was refused.');
    while (this.snapshots.size >= MAX_CHATS)
      this.snapshots.delete(this.snapshots.keys().next().value!);
    const listed = targets.map((target) => ({ ...target, targetId: randomUUID() }));
    this.snapshots.set(chatId, { cwd, expiresAt: this.now() + TTL_MS, targets: listed });
    return listed.map((target) => ({ ...target }));
  }

  /** Capture an accepted ask before queueing; later discovery/TTL cannot retarget it. */
  pin(request: object, chatId: string, cwd: string, targetId: string): AgentTarget {
    const target = this.resolve(chatId, cwd, targetId);
    this.pinned.set(request, { chatId, cwd, target });
    return { ...target };
  }

  resolve(chatId: string, cwd: string, targetId: string, request?: object): AgentTarget {
    const pinned = request ? this.pinned.get(request) : undefined;
    if (
      pinned &&
      pinned.chatId === chatId &&
      pinned.cwd === cwd &&
      pinned.target.targetId === targetId
    )
      return { ...pinned.target };
    this.prune();
    const snapshot = this.snapshots.get(chatId);
    const target =
      snapshot?.cwd === cwd ? snapshot.targets.find((t) => t.targetId === targetId) : undefined;
    if (!target)
      throw new Error(
        'CLI target is unknown or expired. Call list_agent_targets again; nothing was sent.',
      );
    return { ...target };
  }

  private prune(): void {
    for (const [id, entry] of this.snapshots)
      if (entry.expiresAt <= this.now()) this.snapshots.delete(id);
  }
}

/** Opaque ids change on rediscovery; pending-ask deduplication uses identity. */
export function agentTargetIdentity(target: AgentTarget): string {
  return JSON.stringify([
    target.agent,
    target.kind,
    target.cwd,
    target.sessionId,
    target.model,
    target.effort,
  ]);
}

export const agentTargetCatalog = new AgentTargetCatalog();

export async function discoverAgentTargets(
  config: ForgeConfig,
  cwd: string,
  signal?: AbortSignal,
  kind?: 'new_task' | 'existing_session',
) {
  if (!config.agent_bus?.enabled) throw new Error('CLI agent messaging is disabled.');
  const targets: Omit<AgentTarget, 'targetId'>[] = [];
  const errors: string[] = [];
  const sameFolder = (folder: string): boolean => {
    const normalize = (value: string): string => {
      const resolved = path.resolve(value);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    return normalize(folder) === normalize(cwd);
  };
  for (const session of readClaudeSessions()) {
    if (kind === 'new_task' || !session.sessionId || session.sdk || !sameFolder(session.cwd))
      continue;
    targets.push({
      agent: 'claude',
      kind: 'existing_session',
      title: session.name,
      cwd,
      sessionId: session.sessionId,
    });
  }
  try {
    const executable = await resolveCliExecutable(config.agent_bus.codex_cli, 'codex');
    const found = await new CodexDiscovery({
      executable,
      cwd,
      timeoutMs: 15_000,
      ...(signal ? { signal } : {}),
    }).discoverTargets(kind);
    for (const model of found.models) {
      for (const effort of model.supportedReasoningEfforts) {
        targets.push({
          agent: 'codex',
          kind: 'new_task',
          cwd,
          model: model.model,
          effort: effort.reasoningEffort,
          title: `${model.displayName} / ${effort.reasoningEffort}`,
        });
      }
    }
    for (const thread of found.threads.filter((thread) => sameFolder(thread.cwd))) {
      targets.push({
        agent: 'codex',
        kind: 'existing_session',
        cwd,
        sessionId: thread.id,
        title: thread.name ?? thread.preview ?? thread.id,
      });
    }
  } catch (error) {
    signal?.throwIfAborted();
    errors.push(
      `Codex discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { targets, errors };
}
