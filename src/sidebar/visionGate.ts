import type { ToolRegistry } from '../tools/ToolRegistry';

/**
 * The single source of truth for the vision gate (B8). Both halves of the gate
 * — withholding the definition from the request and refusing at dispatch —
 * derive from the registry's `requiresVision` tools, so they cannot drift
 * apart. ModelTurn calls these; the drift test (test/unit/visionGate.test.ts)
 * asserts the two halves agree.
 */

/** Names of registered tools that require a vision projector. */
export function visionGatedNames(registry: ToolRegistry): ReadonlySet<string> {
  return new Set(registry.visionGated().keys());
}

/**
 * The dispatch-refusal map for a non-vision model: tool name → reason naming
 * the model. `undefined` when there are no vision-gated tools (nothing to
 * refuse), mirroring ModelTurn's existing `isVisionModel ? undefined : …`.
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

/**
 * Filter advertised definitions for the vision gate: drop vision-gated tools
 * when the model has no projector. This is the SAME predicate ModelTurn
 * applies to `registry.definitions()`, so the advertise and refuse halves read
 * the same `gated` set and cannot disagree.
 */
export function filterVisionGated<T extends { function: { name: string } }>(
  defs: readonly T[],
  isVisionModel: boolean,
  gated: ReadonlySet<string>,
): T[] {
  if (isVisionModel) return [...defs];
  return defs.filter((d) => !gated.has(d.function.name));
}
