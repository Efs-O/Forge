import type { ToolCall } from '../llm/types';
import type { RegisteredTool, ToolApprovalMetadata, ToolRegistry } from '../tools/ToolRegistry';
import { carriesUntrustedContent, hasConversationReadSecret } from '../tools/exfilTaint';
import { isDangerousDelete } from './deletePreview';
import { resolveWorkspacePath, pathIsInWorkspace } from '../util/WorkspacePaths';
import { decideUntrustedExit, type UntrustedExitInput } from './untrustedExitPolicy';
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
  const approvalMetadata = cached.metadata;
  const isDangerous =
    approvalMetadata?.dangerous ?? (tc.function.name === 'delete_file' && isDangerousDelete(args));
  const rawMutationPaths = reg.mutation?.paths(args) ?? [];
  const mutationPaths = rawMutationPaths.map((filePath) => resolveWorkspacePath(filePath));
  const outsideMutationPaths = mutationPaths.filter((filePath) => !pathIsInWorkspace(filePath));
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
