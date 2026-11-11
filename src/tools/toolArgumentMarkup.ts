/** Repair only a declared argument name followed by leaked XML close markup. */
export function repairParameterMarkup(
  name: string,
  properties: unknown,
  present: Record<string, unknown>,
): string | undefined {
  if (typeof properties !== 'object' || properties === null) return undefined;
  for (const key of Object.keys(present)) {
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
