import * as os from 'os';
import type { ToolCall } from '../llm/types';
import type { RegisteredTool, ToolApprovalMetadata, ToolRegistry } from '../tools/ToolRegistry';
import { carriesUntrustedContent, hasConversationReadSecret } from '../tools/exfilTaint';
import { isDangerousDelete } from './deletePreview';
import { resolveWorkspacePath, pathIsInWorkspace } from '../util/WorkspacePaths';
import type { OwnerOnlySet } from '../tools/ownerPaths';
import {
  isOpenForgeWriteTarget,
  isForgeSkillsWriteTarget,
  SKILL_WRITE_REASON,
} from '../tools/ownerPathsOpen';
import { normalizePathForMatch } from '../tools/secretPaths';
import { decideUntrustedExit, type UntrustedExitInput } from './untrustedExitPolicy';
import { unattendedConversations } from './unattendedConversations';
import type { ToolDispatchRoundContext } from './toolDispatchTypes';

export type CachedToolApproval =
  | { kind: 'value'; metadata: ToolApprovalMetadata | undefined }
  | { kind: 'error'; error: unknown };

export interface ToolApprovalEvaluation {
  approvalMetadata: ToolApprovalMetadata | undefined;
  isDangerous: boolean;
  mutationPaths: string[];
  outsideMutationPaths: string[];
  exitInput: UntrustedExitInput;
  exitVerdict: ReturnType<typeof decideUntrustedExit>;
}

/** Paths in the explicitly open Forge memory/skill areas do not need an outside-workspace card. */
export function isMutationPathOutsideWorkspace(filePath: string, ownerSet: OwnerOnlySet): boolean {
  const normalized = normalizePathForMatch(filePath, ownerSet.platform);
  return !pathIsInWorkspace(filePath) && !isOpenForgeWriteTarget(normalized, ownerSet);
}

/** The environment these two questions are asked with: the owner's own home, on
 *  this OS, with no roots — the open areas are built in, not configured. */
function forgeOwnerSet(): OwnerOnlySet {
  return { roots: [], home: os.homedir(), platform: process.platform };
}

function outsideWorkspaceMutationPaths(paths: readonly string[]): string[] {
  const ownerSet = forgeOwnerSet();
  return paths.filter((filePath) => isMutationPathOutsideWorkspace(filePath, ownerSet));
}

/** A write that lands in `~/.forge/skills`, whatever else the call touches. */
function writesForgeSkill(paths: readonly string[]): boolean {
  const ownerSet = forgeOwnerSet();
  return paths.some((filePath) =>
    isForgeSkillsWriteTarget(normalizePathForMatch(filePath, ownerSet.platform), ownerSet),
  );
}

/** The card a skill write owes the owner, layered on whatever the tool's own gate
 *  said, so a tool that already raised a card keeps its detail and gate kind.
 *
 * `approvalKey` and `approvalTargets` go, because the call no longer asks the
 * thing that key describes: with no key and `dangerous` set, `approvalKeysFor`
 * fails closed, so the card carries no offer and Clanker and an unattended run
 * both leave it to the owner. `cardTextOnly` goes for the same reason in reverse:
 * it means "no gate", and this is one. */
function skillWriteGate(
  metadata: ToolApprovalMetadata | undefined,
  mutationPaths: readonly string[],
): ToolApprovalMetadata | undefined {
  if (!writesForgeSkill(mutationPaths)) return metadata;
  const base: ToolApprovalMetadata = { ...(metadata ?? {}) };
  delete base.approvalKey;
  delete base.approvalTargets;
  delete base.cardTextOnly;
  return { ...base, dangerous: true, clankerStop: true, cardReason: SKILL_WRITE_REASON };
}

export async function readToolApprovalMetadata(
  reg: RegisteredTool,
  args: Record<string, unknown>,
  convId: string | undefined,
): Promise<CachedToolApproval> {
  try {
    const metadata = await reg.approval?.(args, convId ? { conversationId: convId } : undefined);
    return { kind: 'value', metadata };
  } catch (error) {
    return { kind: 'error', error };
  }
}

/** Shared by the serial path and parallel-read preflight so the gate cannot drift. */
export function evaluateToolApproval(
  tc: ToolCall,
  reg: RegisteredTool,
  args: Record<string, unknown>,
  context: ToolDispatchRoundContext,
  cached: CachedToolApproval,
  toolRegistry: ToolRegistry,
): ToolApprovalEvaluation {
  if (cached.kind === 'error') throw cached.error;
  const rawMutationPaths = reg.mutation?.paths(args) ?? [];
  const mutationPaths = rawMutationPaths.map((filePath) => resolveWorkspacePath(filePath));
  // Read from the resolved paths: a skill file spelled `~/.forge/skills/...` or
  // relative to the workspace is the same write the tool is about to make.
  const approvalMetadata = skillWriteGate(
    // A tool that declares `unattendedGate` has no card anywhere else: the gate is
    // for a run nobody is in, and the tool's own gate answers that call first when
    // it raised one. An attended chat sees no metadata and no card, exactly as before.
    cached.metadata ??
      (reg.unattendedGate !== undefined &&
      context.convId !== undefined &&
      unattendedConversations.has(context.convId)
        ? reg.unattendedGate
        : undefined),
    mutationPaths,
  );
  const isDangerous =
    approvalMetadata?.dangerous ?? (tc.function.name === 'delete_file' && isDangerousDelete(args));
  const outsideMutationPaths = outsideWorkspaceMutationPaths(mutationPaths);
  const exitInput: UntrustedExitInput = {
    toolName: tc.function.name,
    dangerous: isDangerous,
    toolGate: approvalMetadata !== undefined && approvalMetadata.cardTextOnly !== true,
    outsideWorkspace: outsideMutationPaths.length > 0,
    declaredSafe: reg.autoApprove === true || reg.autoApproveIf?.(args) === true,
    reachesOut: approvalMetadata?.reachesOut ?? reg.reachesOut ?? 'none',
    untrustedContent: carriesUntrustedContent(
      context.convId,
      context.modelContext?.conversation,
      toolRegistry,
    ),
    readSecret: hasConversationReadSecret(context.convId),
  };
  return {
    approvalMetadata,
    isDangerous,
    mutationPaths,
    outsideMutationPaths,
    exitInput,
    exitVerdict: decideUntrustedExit(exitInput),
  };
}
