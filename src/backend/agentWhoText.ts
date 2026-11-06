/** Tab-delimited projection used by forge.sh; JSON remains the public default. */
export function formatWhoText(participants: unknown): string {
  return (Array.isArray(participants) ? participants : [])
    .map((participant) =>
      ['session', 'attachment', 'activity', 'detail']
        .map((key) =>
          String((participant as Record<string, unknown> | null | undefined)?.[key] ?? '').replace(
            /[\t\r\n]/gu,
            ' ',
          ),
        )
        .join('\t'),
    )
    .join('\n');
}
