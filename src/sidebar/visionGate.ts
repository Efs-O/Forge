import type { ToolRegistry } from '../tools/ToolRegistry';

/**
 * `requiresVision` is the dispatch refusal source of truth. ModelTurn leaves
 * those definitions advertised on text-only models so this message explains
 * the limitation when the tool is called.
 */

/** Names of registered tools that require a vision projector. */
export function visionGatedNames(registry: ToolRegistry): ReadonlySet<string> {
  return new Set(registry.visionGated().keys());
}

/**
 * The dispatch-refusal map for a non-vision model: tool name → reason naming
 * the model. `undefined` when there are no vision-gated tools (nothing to
 * refuse).
 */
export function buildVisionRefusals(
  registry: ToolRegistry,
  modelName: string,
): Map<string, string> | undefined {
  const gated = registry.visionGated();
  if (gated.size === 0) return undefined;
  const map = new Map<string, string>();
  for (const [name, fn] of gated) map.set(name, fn(modelName));
  return map;
}
