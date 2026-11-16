/**
 * The one job-reference resolver. The `manage_jobs` tool and the remote
 * `/job <n|name>` commands answer the same question — which job does this
 * reference name — and both load the list from the same `JobStore`, so they
 * must not carry two copies of the matching rules: a reference that resolves
 * in one surface and not the other is a bug the owner cannot see coming.
 *
 * The remote surface also lets the owner name a job by its position in the
 * `/jobs` list. That precedence is remote-only (the tool has no list numbering
 * to point at), so it stays a wrapper in `remote/RemoteJobCommands.ts`, which
 * resolves a bare number against its own list before delegating here.
 */
import type { JobFile } from './jobSchema';

/** The result of fuzzy-matching a job reference. */
export type JobMatch =
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: JobFile[] }
  | { kind: 'one'; jobFile: JobFile };

/** Resolve a job by exact id, exact name, or unique substring (case-insensitive). */
export function resolveJobRef(all: readonly JobFile[], ref: string): JobMatch {
  const needle = ref.trim().toLowerCase();
  const exact = all.find(
    (jf) => jf.job.id.toLowerCase() === needle || jf.job.name.toLowerCase() === needle,
  );
  if (exact) return { kind: 'one', jobFile: exact };
  const partial = all.filter(
    (jf) => jf.job.id.toLowerCase().includes(needle) || jf.job.name.toLowerCase().includes(needle),
  );
  if (partial.length === 0) return { kind: 'none' };
  if (partial.length === 1) return { kind: 'one', jobFile: partial[0]! };
  return { kind: 'ambiguous', candidates: partial };
}

/**
 * Why `ref` is not a job id, or undefined when a job's id is exactly `ref`.
 * The agent's job tool changes a job only by its exact id: its Undo copy is
 * taken from the path that id names, before the job is looked up.
 */
export function exactJobIdRefusal(
  all: readonly JobFile[],
  ref: string,
  action: string,
): string | undefined {
  if (all.some((jf) => jf.job.id === ref)) return undefined;
  const match = resolveJobRef(all, ref);
  const head = `manage_jobs: \`${action}\` needs the exact job id.`;
  if (match.kind === 'one') {
    const { id, name } = match.jobFile.job;
    return `${head} "${ref}" matches "${name}" (${id}). Resend with job: "${id}". Nothing changed.`;
  }
  if (match.kind === 'ambiguous') {
    const names = match.candidates.map((jf) => `${jf.job.name} (${jf.job.id})`).join(', ');
    return `${head} "${ref}" matches: ${names}. Resend with one of those ids. Nothing changed.`;
  }
  return `${head} No job has the id "${ref}". List the jobs with {action:"list"} to see the ids. Nothing changed.`;
}
