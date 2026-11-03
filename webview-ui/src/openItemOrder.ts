/** Keep captured open-tab order, putting tabs that appear later at the top. */
export function orderOpenItems<T extends { id: string }>(
  items: readonly T[],
  frozenIds: readonly string[],
): T[] {
  const positions = new Map(frozenIds.map((id, index) => [id, index]));
  const added: T[] = [];
  const captured: T[] = [];

  for (const item of items) {
    if (positions.has(item.id)) captured.push(item);
    else added.push(item);
  }

  captured.sort((a, b) => positions.get(a.id)! - positions.get(b.id)!);
  return [...added, ...captured];
}
