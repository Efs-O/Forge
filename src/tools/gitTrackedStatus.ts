/**
 * Whether a path is under git's control — asked at the moment something is
 * about to delete it.
 *
 * A file's *content* says nothing about its role. An agent hashed `CHANGES.md`
 * and `CHANGELOG.md`, found them byte-identical, concluded one was a redundant
 * copy, and deleted the tracked source of truth — the generated artifact was
 * the survivor. Nothing in `delete_file`'s result, and nothing in the approval
 * dialog the user clicked, mentioned that one of the two was committed and the
 * other was gitignored. That single fact would have settled it.
 *
 * Deliberately non-fatal: every failure mode collapses to `not-a-repo`. This
 * runs on the path to a deletion the caller already decided on, so it may add
 * information but must never be the reason a deletion fails.
 */

import { getRepo, repoRelative, runGit, type GitRepoHandle } from './gitRepo';

export type TrackedState = 'tracked' | 'untracked' | 'ignored' | 'not-a-repo';

/**
 * Classify `filePath` (absolute or workspace-relative).
 *
 * Discovery goes through `getRepo`, so a repository nested inside the
 * workspace root is asked about itself rather than about its parent — the
 * workspace root is not the project root.
 */
export async function describeTrackedState(filePath: string): Promise<TrackedState> {
  let repo: GitRepoHandle;
  let relative: string;
  try {
    repo = await getRepo(filePath);
    relative = repoRelative(repo, filePath);
  } catch {
    return 'not-a-repo';
  }

  // `--error-unmatch` exits non-zero when the pathspec matches nothing in the
  // index, which `runGit` surfaces as a throw. A directory counts as tracked
  // when any file beneath it is.
  try {
    await runGit(repo, ['ls-files', '--error-unmatch', '--', relative]);
    return 'tracked';
  } catch {
    // Not in the index — fall through and ask whether it is ignored.
  }

  try {
    await runGit(repo, ['check-ignore', '-q', '--', relative]);
    return 'ignored';
  } catch {
    return 'untracked';
  }
}

/** One line for the delete approval dialog, in the user's terms. */
export async function describeGitLineForDelete(filePath: string): Promise<string> {
  switch (await describeTrackedState(filePath)) {
    case 'tracked':
      return 'tracked — this path is committed to the repository.';
    case 'ignored':
      return 'ignored — gitignored, so it is most likely generated.';
    case 'untracked':
      return 'untracked — never committed, so git cannot restore it.';
    case 'not-a-repo':
      return 'not in a git repository.';
  }
}

/**
 * The sentence appended to a delete result, or empty for the cases that carry
 * no warning.
 *
 * Phrased as a fact plus the two exits, because guidance in a tool's return
 * string arrives exactly when it is relevant and costs nothing on the turns it
 * is not. The alternative — a standing prompt rule — is paid for on every turn
 * of every session.
 */
export function describeDeletedTrackedFile(state: TrackedState, filePath: string): string {
  if (state !== 'tracked') return '';
  return (
    `This file was tracked in git at HEAD, so it was part of the committed tree — ` +
    `identical content elsewhere does not make it a redundant copy. If deleting it ` +
    `was not intended, restore it with restore_file({"path": ${JSON.stringify(filePath)}}), ` +
    `or undo the whole turn.`
  );
}
