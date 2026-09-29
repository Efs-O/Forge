import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { buildVisionRefusals, filterVisionGated, visionGatedNames } from '../../src/sidebar/visionGate';

function def(name: string) {
  return {
    type: 'function' as const,
    function: { name, description: name, parameters: { type: 'object' as const } },
  };
}

/**
 * B8: the vision gate has a single source of truth (the registry's
 * `requiresVision` tools). Both halves — withholding the definition and
 * refusing at dispatch — must agree. This test fails if a vision-gated tool
 * could be advertised to a non-vision model without also being refused.
 */
describe('vision gate (B8 single source of truth)', () => {
  it('a vision-gated tool is withheld AND refused for a non-vision model (no drift)', () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: def('view_image'),
      permission: 'read',
      requiresVision: (name) =>
        `Error: view_image is not available because the active model "${name}" has no vision projector configured (mmproj_path).`,
      handler: async () => 'x',
    });
    registry.register({
      definition: def('browser_screenshot'),
      permission: 'browser',
      requiresVision: (name) => `Error: browser_screenshot needs a vision model; "${name}" has none.`,
      handler: async () => 'x',
    });
    registry.register({
      definition: def('read_file'),
      permission: 'read',
      handler: async () => 'x',
    });

    const gated = visionGatedNames(registry);
    expect([...gated].sort()).toEqual(['browser_screenshot', 'view_image']);

    // Advertise half: a non-vision model must NOT see the gated tools.
    const advertised = filterVisionGated(
      registry.definitions(new Set(['read', 'browser'])),
      false,
      gated,
    ).map((d) => d.function.name);
    expect(advertised).toEqual(['read_file']);

    // Refuse half: every gated tool is refused, naming the model.
    const refusals = buildVisionRefusals(registry, 'test-model');
    expect(refusals).toBeDefined();
    expect([...refusals!.keys()].sort()).toEqual(['browser_screenshot', 'view_image']);
    expect(refusals!.get('view_image')).toContain('test-model');

    // The invariant: anything refused is withheld, and every gated tool is refused.
    for (const name of refusals!.keys()) expect(advertised).not.toContain(name);
    for (const name of gated) expect(refusals!.has(name)).toBe(true);

    // A vision model sees everything (the gate is a no-op for it).
    const advertisedVision = filterVisionGated(
      registry.definitions(new Set(['read', 'browser'])),
      true,
      gated,
    ).map((d) => d.function.name);
    expect([...advertisedVision].sort()).toEqual(['browser_screenshot', 'read_file', 'view_image']);
  });

  it('no vision-gated tools → undefined refusals, nothing filtered', () => {
    const registry = new ToolRegistry();
    registry.register({ definition: def('read_file'), permission: 'read', handler: async () => 'x' });
    const gated = visionGatedNames(registry);
    expect(gated.size).toBe(0);
    expect(buildVisionRefusals(registry, 'test-model')).toBeUndefined();
    const advertised = filterVisionGated(
      registry.definitions(new Set(['read'])),
      false,
      gated,
    ).map((d) => d.function.name);
    expect(advertised).toEqual(['read_file']);
  });
});
