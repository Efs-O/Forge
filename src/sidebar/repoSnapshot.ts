/**
 * The working tree as git sees it, captured at compaction time.
 *
 * Split from `compactionLedger.ts` on the dependency seam: that file derives
 * facts from the messages alone and needs nothing from the environment, while
 * everything here shells out. Keeping them apart is what lets the ledger's
 * classification be tested without git, a workspace, or a mocked `vscode`.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { gitCwd } from '../tools/gitRepo';
import { getLogger } from '../util/logger';

const execFileAsync = promisify(execFile);
const log = getLogger();

/** Bounds on the git snapshot. A slow repo must not stall a compaction. */
const GIT_TIMEOUT_MS = 3000;
const GIT_MAX_BUFFER = 512 * 1024;
const STATUS_MAX_LINES = 20;
const SNAPSHOT_MAX_CHARS = 1200;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout.trim();
}

/** `--stat`'s last line is the totals; the per-file rows are already in the
 *  status listing, so only the summary line earns its place here. */
function statTotals(stat: string): string {
  const lines = stat.split(/\r?\n/).filter((line) => line.trim());
  return lines.length > 0 ? (lines[lines.length - 1] as string).trim() : 'no changes';
}

function statusLines(status: string): string {
  const lines = status.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return '(clean)';
  const shown = lines.slice(0, STATUS_MAX_LINES);
  const more = lines.length > shown.length ? `\n…and ${lines.length - shown.length} more` : '';
  return `${shown.join('\n')}${more}`;
}

/**
 * The working tree as git sees it, for a resumed agent to check its own ledger
 * against without spending a tool call.
 *
 * `git diff --stat` alone is NOT repo state: it reports unstaged changes to
 * tracked files and silently omits both staged changes and untracked files. An
 * agent that had just created and staged three files would read an empty diff
 * and conclude nothing happened — the exact failure this block exists to
 * prevent. So all three views are captured and each is labelled for what it is.
 *
 * Returns '' on any failure. A missing block costs the agent one verification
 * round; a throw here would lose the whole summary.
 */
export async function snapshotRepoState(): Promise<string> {
  try {
    const cwd = gitCwd();
    // Concurrent, not sequential: three separate 3s timeouts would otherwise
    // add up to a 9s stall on the compaction path.
    const [unstaged, staged, status] = await Promise.all([
      git(cwd, ['diff', '--stat']),
      git(cwd, ['diff', '--staged', '--stat']),
      git(cwd, ['status', '--short']),
    ]);
    const block =
      `\n\n**Working-tree state at compaction (recorded by Forge, \`git\` at ${cwd}):**\n` +
      `Unstaged (tracked): ${statTotals(unstaged)}\n` +
      `Staged: ${statTotals(staged)}\n` +
      `git status --short:\n${statusLines(status)}`;
    return block.length <= SNAPSHOT_MAX_CHARS
      ? block
      : `${block.slice(0, SNAPSHOT_MAX_CHARS)}\n…[snapshot truncated]`;
  } catch (err) {
    // Not a repo, git absent, timed out, or the workspace has no folder. All
    // are ordinary, none is worth a warning the user cannot act on.
    log.info(`[compact] repo snapshot unavailable — ${(err as Error).message}`);
    return '';
  }
}
