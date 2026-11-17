import { beforeAll, describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
// @ts-expect-error -- the standalone catalog is a plain ESM script
import { extractToolAuditSnapshot } from '../../scripts/tool-audit-catalog.mjs';
// The harness core is deliberately plain ESM so the standalone Node audit script and
// Vitest exercise the exact same comparison implementation.
// @ts-expect-error -- the JavaScript audit helper intentionally has no production typings
import {
  structuralArgsEqual,
  synthesizeArgs,
  validateAgainstSchema,
} from '../../scripts/tool-harness-core.mjs';

type ToolDefinition = {
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

// ---------------------------------------------------------------------------
// A JSON-Schema -> fast-check arbitrary builder, covering exactly the keywords
// `validateAgainstSchema` enforces (type, enum, anyOf/oneOf, object
// required/additionalProperties:false, and the minimum/maximum/minLength/
// maxLength/minItems/maxItems bounds). A schema feature the builder cannot
// honour is reported as a named skip rather than silently passed.
// ---------------------------------------------------------------------------

class SkipTool extends Error {}

function arbFromSchema(schema: unknown): fc.Arbitrary<unknown> {
  if (schema === undefined || schema === null) return fc.constant(null);
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    throw new SkipTool(`non-object schema node: ${JSON.stringify(schema)}`);
  }
  const node = schema as Record<string, unknown>;

  // anyOf / oneOf: the validator accepts a value matching ANY branch, so
  // generate for the first branch the builder can satisfy (preferring a
  // non-null branch, exactly as `synthesizeArgs` does).
  const alternatives = (node.anyOf ?? node.oneOf) as unknown[] | undefined;
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    const nonNull = alternatives.filter(
      (branch) => !(branch && typeof branch === 'object' && (branch as { type?: unknown }).type === 'null'),
    );
    const order = [...nonNull, ...alternatives];
    let lastError = 'no branch buildable';
    for (const branch of order) {
      try {
        return arbFromSchema(branch);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new SkipTool(`anyOf/oneOf unbuildable (${lastError})`);
  }

  if (Array.isArray(node.allOf)) {
    throw new SkipTool('allOf not covered by the builder');
  }

  if (Array.isArray(node.enum)) {
    if (node.enum.length === 0) throw new SkipTool('empty enum');
    return fc.constantFrom(...(node.enum as unknown[]));
  }

  const typeList = Array.isArray(node.type)
    ? (node.type as unknown[])
    : node.type !== undefined
      ? [node.type]
      : [];
  const type = (typeList.find((candidate) => candidate !== 'null') ?? typeList[0]) as
    | string
    | undefined;

  if (type === undefined) {
    // No type, no enum, no combinator: the validator runs no check, so any
    // value passes. Treat a bare object-with-properties as an object.
    if (node.properties && typeof node.properties === 'object') return arbObject(node);
    return fc.constant(null);
  }

  if (type === 'null') return fc.constant(null);
  if (type === 'boolean') return fc.boolean();
  if (type === 'string') return arbString(node);
  if (type === 'integer') return arbInteger(node);
  if (type === 'number') return arbNumber(node);
  if (type === 'array') return arbArray(node);
  if (type === 'object') return arbObject(node);

  throw new SkipTool(`unhandled type ${JSON.stringify(type)}`);
}

function arbString(node: Record<string, unknown>): fc.Arbitrary<string> {
  const minLength = typeof node.minLength === 'number' ? node.minLength : 0;
  const declaredMax = typeof node.maxLength === 'number' ? node.maxLength : undefined;
  if (minLength > 2000) throw new SkipTool(`string minLength ${minLength} too large to build`);
  // Generate a length inside [minLength, min(declaredMax, cap)]: any length
  // within the schema bounds validates, so a large declared maxLength needs
  // not be produced in full.
  const upper = Math.min(declaredMax ?? Number.MAX_SAFE_INTEGER, Math.max(minLength, 24));
  const maxLength = Math.max(minLength, upper);
  return fc.string({ minLength, maxLength });
}

function numericRange(node: Record<string, unknown>): [number, number] {
  const minimum = typeof node.minimum === 'number' ? node.minimum : undefined;
  const maximum = typeof node.maximum === 'number' ? node.maximum : undefined;
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw new SkipTool(`minimum ${minimum} exceeds maximum ${maximum}`);
  }
  return [minimum ?? -1000, maximum ?? 1000];
}

function arbInteger(node: Record<string, unknown>): fc.Arbitrary<number> {
  const [lo, hi] = numericRange(node);
  const min = Math.ceil(lo);
  const max = Math.floor(hi);
  const safeMax = Math.max(min, Math.min(max, 1_000_000));
  return fc.integer({ min, max: safeMax });
}

function arbNumber(node: Record<string, unknown>): fc.Arbitrary<number> {
  const [lo, hi] = numericRange(node);
  const min = Math.ceil(lo);
  const max = Math.floor(hi);
  if (min <= max) {
    return fc.integer({ min, max: Math.max(min, Math.min(max, 1_000_000)) });
  }
  // Fractional-only range: emit a finite double inside [lo, hi].
  return fc.double({ min: lo, max: hi, noNaN: true, noDefaultNaN: true });
}

function arbArray(node: Record<string, unknown>): fc.Arbitrary<unknown[]> {
  const minItems = typeof node.minItems === 'number' ? node.minItems : 0;
  const declaredMax = typeof node.maxItems === 'number' ? node.maxItems : undefined;
  if (minItems > 100) throw new SkipTool(`array minItems ${minItems} too large to build`);
  // Any length inside the schema bounds validates, so a large declared
  // maxItems need not be produced in full.
  const upper = Math.min(declaredMax ?? Number.MAX_SAFE_INTEGER, Math.max(minItems, 3));
  const maxLength = Math.max(minItems, upper);
  const items = node.items;
  const elementArb =
    items === undefined
      ? fc.string({ maxLength: 4 })
      : Array.isArray(items)
        ? fc.string({ maxLength: 4 })
        : arbFromSchema(items);
  return fc.array(elementArb, { minLength: minItems, maxLength });
}

function arbObject(node: Record<string, unknown>): fc.Arbitrary<Record<string, unknown>> {
  const properties =
    node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)
      ? (node.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(node.required) ? (node.required as string[]) : [];
  const additionalFalse = node.additionalProperties === false;
  const keys = Object.keys(properties);
  const requiredNotInProps = required.filter((key) => !(key in properties));
  if (additionalFalse && requiredNotInProps.length > 0) {
    throw new SkipTool(`required keys absent from properties with additionalProperties:false`);
  }

  const entryArbs: Array<fc.Arbitrary<readonly [string, unknown] | null>> = keys.map((key) => {
    const valueArb = arbFromSchema(properties[key]);
    if (required.includes(key)) return valueArb.map((value) => [key, value] as const);
    return fc
      .boolean()
      .chain((include) =>
        include ? valueArb.map((value) => [key, value] as const) : fc.constant(null),
      );
  });

  const extraRequired: Array<fc.Arbitrary<readonly [string, unknown]>> = requiredNotInProps.map(
    (key) => fc.constant([key, null] as const),
  );

  const all = [...entryArbs, ...extraRequired];
  if (all.length === 0) return fc.constant({});
  return fc.tuple(...all).map((pairs) => {
    const obj: Record<string, unknown> = {};
    for (const pair of pairs) {
      if (pair) obj[pair[0]] = pair[1];
    }
    return obj;
  });
}

// ---------------------------------------------------------------------------
// structuralArgsEqual is util.isDeepStrictEqual: key order is ignored, array
// order is significant, and any value equals itself.
// ---------------------------------------------------------------------------

function deepReverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepReverseKeys);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    // Preserve the prototype: isDeepStrictEqual compares prototypes, and a
    // null-prototype dictionary must not be cloned into a normal object.
    const out = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
    for (const key of Object.keys(source).reverse()) out[key] = deepReverseKeys(source[key]);
    return out;
  }
  return value;
}

describe('property: structuralArgsEqual invariants', () => {
  it('is reflexive for any JSON value', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => structuralArgsEqual(value, value) === true),
    );
  });

  it('ignores object key order, including nested objects', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), fc.jsonValue(), {
          minKeys: 2,
          maxKeys: 5,
        }),
        (value) => structuralArgsEqual(value, deepReverseKeys(value)) === true,
      ),
    );
  });

  it('treats a reordered array of distinct items as unequal', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer(), { minLength: 2, maxLength: 6 }),
        (items) =>
          structuralArgsEqual({ values: items }, { values: [...items].reverse() }) === false,
      ),
    );
  });
});

describe('property: live tool catalog arguments validate', () => {
  let definitions: ToolDefinition[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const built = new Map<string, { arb: fc.Arbitrary<unknown>; params: Record<string, unknown> }>();

  beforeAll(async () => {
    const snapshot = await extractToolAuditSnapshot();
    definitions = snapshot.definitions as ToolDefinition[];
    for (const definition of definitions) {
      const name = definition.function.name;
      const params = definition.function.parameters;
      try {
        built.set(name, { arb: arbFromSchema(params), params });
      } catch (error) {
        skipped.push({
          name,
          reason: error instanceof SkipTool ? error.message : `builder threw: ${String(error)}`,
        });
      }
    }
  }, 30_000);

  it('has a catalog to test', () => {
    expect(definitions.length).toBeGreaterThan(40);
  });

  it('generated arguments satisfy the schema for every tool', () => {
    // One fast-check property per tool, run after the catalog is loaded. A
    // failure records the tool name and the shrunk counterexample fast-check
    // prints, so the suite reports which tool and with what arguments.
    const failures: Array<{ name: string; message: string }> = [];
    expect(built.size).toBeGreaterThan(40);
    for (const [name, entry] of built) {
      try {
        fc.assert(
          fc.property(
            entry.arb,
            (value) => validateAgainstSchema(value, entry.params).length === 0,
          ),
        );
      } catch (error) {
        failures.push({ name, message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (failures.length > 0) {
      // eslint-disable-next-line no-console
      console.log('GENERATED_ARG_FAILURES', JSON.stringify(failures, null, 2));
    }
    expect(failures).toEqual([]);
  }, 60_000);

  it('synthesized arguments satisfy the schema for every tool', () => {
    const failures: Array<{ name: string; detail: string }> = [];
    for (const definition of definitions) {
      const name = definition.function.name;
      const params = definition.function.parameters;
      try {
        const args = synthesizeArgs(params);
        const errors = validateAgainstSchema(args, params);
        if (errors.length > 0) failures.push({ name, detail: errors.join('; ') });
      } catch (error) {
        failures.push({ name, detail: `synthesizeArgs threw: ${String(error)}` });
      }
    }
    expect(failures).toEqual([]);
  });

  it('reports the builder skips by name', () => {
    // Every tool whose schema the builder could not turn into an arbitrary is
    // recorded here with a reason; the report captures the list. With the
    // builder covering the live catalog, this is empty.
    for (const definition of definitions) {
      if (!built.has(definition.function.name)) {
        expect(skipped.some((skip) => skip.name === definition.function.name)).toBe(true);
      }
    }
    if (skipped.length > 0) {
      // eslint-disable-next-line no-console
      console.log('SKIPPED_TOOLS', JSON.stringify(skipped));
    }
  });
});
