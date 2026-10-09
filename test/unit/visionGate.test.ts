import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { buildVisionRefusals, visionGatedNames } from '../../src/sidebar/visionGate';

function def(name: string) {
  return {
    type: 'function' as const,
    function: { name, description: name, parameters: { type: 'object' as const } },
  };
}

/**
 * B8: every `requiresVision` tool remains advertised, and dispatch carries
 * the matching refusal so a text-only model gets an actionable explanation.
 */
describe('vision gate (B8 single source of truth)', () => {
  it('advertises every vision-gated tool and refuses it on non-vision models', () => {
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

    // Advertise half: tools remain visible so their refusal can explain why.
    const advertised = registry.definitions(new Set(['read', 'browser'])).map((d) => d.function.name);
    expect([...advertised].sort()).toEqual(['browser_screenshot', 'read_file', 'view_image']);

    // Refuse half: every gated tool is refused, naming the model.
    const refusals = buildVisionRefusals(registry, 'test-model');
    expect(refusals).toBeDefined();
    expect([...refusals!.keys()].sort()).toEqual(['browser_screenshot', 'view_image']);
    expect(refusals!.get('view_image')).toContain('test-model');

    // The invariant: every gated tool is both advertised and refused.
    for (const name of refusals!.keys()) expect(advertised).toContain(name);
    for (const name of gated) expect(refusals!.has(name)).toBe(true);

    // A vision model sees everything (the gate is a no-op for it).
    const advertisedVision = registry.definitions(new Set(['read', 'browser'])).map((d) => d.function.name);
    expect([...advertisedVision].sort()).toEqual(['browser_screenshot', 'read_file', 'view_image']);
  });

  it('no vision-gated tools → undefined refusals, definitions stay unchanged', () => {
    const registry = new ToolRegistry();
    registry.register({ definition: def('read_file'), permission: 'read', handler: async () => 'x' });
    const gated = visionGatedNames(registry);
    expect(gated.size).toBe(0);
    expect(buildVisionRefusals(registry, 'test-model')).toBeUndefined();
    const advertised = registry.definitions(new Set(['read'])).map((d) => d.function.name);
    expect(advertised).toEqual(['read_file']);
  });
});
