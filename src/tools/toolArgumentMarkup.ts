/**
 * Repair an argument name that arrived mangled but unambiguous: leaked XML
 * close markup after a declared name, or a stray `=` before one. Both are
 * renames onto a declared argument that is not already in the call; anything
 * else is left alone so the ordinary unknown-argument refusal still fires.
 */
export function repairParameterMarkup(
  name: string,
  properties: unknown,
  present: Record<string, unknown>,
): string | undefined {
  if (typeof properties !== 'object' || properties === null) return undefined;
  for (const key of Object.keys(present)) {
    // A key that arrived as `=query` is the same argument with a stray `=` —
    // the shape a model writes when it renders `--query=` or `<parameter
    // name=query>` as text. Same rule as the markup repair below: rename only
    // when the rest is a declared argument and that argument is not already in
    // the call, so `=query` beside `query` stays a refusal.
    const equals = /^=(.+)$/u.exec(key);
    const equalsTarget = equals?.[1];
    if (
      equalsTarget &&
      Object.hasOwn(properties, equalsTarget) &&
      present[equalsTarget] === undefined
    ) {
      present[equalsTarget] = present[key];
      delete present[key];
      continue;
    }
    const match = /^(.+)<\/parameter>?$/u.exec(key);
    const argument = match?.[1];
    if (!argument || !Object.hasOwn(properties, argument)) continue;
    const value = present[key];
    if (
      typeof value === 'string' &&
      (value === '<parameter name>' || value.startsWith('<parameter name='))
    ) {
      return (
        name +
        ': argument "' +
        argument +
        '" arrived as tool-call markup (' +
        value +
        '), not a value. Send it again as plain JSON.'
      );
    }
    if (present[argument] !== undefined) continue;
    present[argument] = value;
    delete present[key];
  }
  return undefined;
}
