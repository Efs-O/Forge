/**
 * The owner-only wall attached to a file-mutating tool.
 *
 * Split out of `ownerPaths.ts` (2026-11-24): what moves is the wall's one
 * adapter to the dispatch pipeline — which of a tool's declared paths to judge,
 * where the refusal must be raised so no card comes first, and what
 * `ToolRegistry.invalidArgs` expects back — while `ownerPaths.ts` keeps
 * answering which paths are owner-only and what the refusal says. This file
 * owns no policy of its own: it asks `ownerPaths.ts` both questions.
 *
 * Importer: `registerAllTools.ts`, which wraps every file tool with it.
 */
import {
  ownerOnlyToolRefusal,
  ownerOnlyWriteTargetFor,
  type OwnerOnlyHit,
  type OwnerOnlySet,
} from './ownerPaths';
import type { RegisteredTool } from './ToolRegistry';

/**
 * Wraps a file-mutating tool so an owner-only target is refused in every mode,
 * before any card and before the handler runs.
 *
 * Two entry points, one implementation, both wired and both tested:
 * - `refuseBeforeApproval`, called by `ToolRegistry.invalidArgs`, which
 *   `ToolDispatch.ts` runs before it decides whether to raise a card. This is
 *   what makes the refusal card-free in normal, unattended and `/clanker` mode:
 *   a refusal from the handler alone would be a card first, because an attended
 *   `write_file` always raises one, and the user approving it would still end
 *   in a refusal.
 * - the handler, for callers that dispatch without that pre-check —
 *   `ToolRegistry.dispatch` is called directly by `benchmark/toolHost.ts`, and a
 *   guard that only lived in the pre-check would be switched off for a benchmark
 *   turn by a line elsewhere in the tree.
 *
 * Both read `tool.mutation.paths(args)` — the paths the tool itself declares it
 * will write, the same list the checkpoint snapshots and the diff renders — so a
 * wrapped tool cannot disagree with its own diff, and a tool that names several
 * paths (`delete_file`, `move_file`) is refused whole: nothing it names is
 * touched, so a refused batch cannot half-delete.
 */
export function applyOwnerOnlyWriteGuard(
  tool: RegisteredTool,
  set: () => OwnerOnlySet,
): RegisteredTool {
  const name = tool.definition.function.name;
  const hitFor = (args: Record<string, unknown>): OwnerOnlyHit | undefined => {
    const targets = tool.mutation?.paths(args) ?? [];
    for (const supplied of targets) {
      if (typeof supplied !== 'string') continue;
      const hit = ownerOnlyWriteTargetFor(supplied, set());
      if (hit) return hit;
    }
    return undefined;
  };
  const refusalFor = (args: Record<string, unknown>): string | undefined => {
    const hit = hitFor(args);
    return hit ? ownerOnlyToolRefusal(name, hit) : undefined;
  };
  return {
    ...tool,
    refuseBeforeApproval: (args, context) => {
      const refusal = refusalFor(args);
      // `invalidArgs` refusals carry the `Error:` prefix by that file's
      // convention; the handler throws the same sentence bare and
      // `toolErrorText.ts` adds it, so both paths say the same thing.
      // The wrapped tool's own pre-check runs after the wall, never instead of it.
      return refusal ? `Error: ${refusal}` : tool.refuseBeforeApproval?.(args, context);
    },
    handler: async (args, context) => {
      const hit = hitFor(args);
      if (hit) throw new Error(ownerOnlyToolRefusal(name, hit));
      return tool.handler(args, context);
    },
  };
}
