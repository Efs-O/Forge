/** Build the stable slug used as the base id for a job name. */
export function jobSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'job'
  );
}

/** Build a slug id, adding a numeric suffix when the base id is already taken. */
export function uniqueJobId(name: string, taken: ReadonlySet<string>): string {
  const slug = jobSlug(name);
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const candidate = `${slug}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
