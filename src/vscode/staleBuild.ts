import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getLogger } from '../util/logger';

/**
 * "This window is running an older Forge than the one on disk."
 *
 * VS Code swaps a newly installed extension in only at a window reload, so a
 * window that has been open since before an upgrade keeps executing the old
 * build while the machine has the new one. On 2026-10-27 that was the real
 * cause of a failed 08:04 job: the config was fine for the installed build
 * (0.17.87, which had the fix), but the window running the job had loaded
 * 0.17.86 the night before and nothing said so. The job reported a config
 * validation error, and the owner spent the morning on the wrong thing.
 *
 * The check is recomputed at every call and never stored (the versions change
 * under a running window): at a scheduled job start, and when a config load or
 * write fails. Those are the two moments where a stale build explains a failure
 * that would otherwise be blamed on the config.
 */

/** The extension id Forge is installed under; its folder name in the VS Code
 *  extensions directory is `<id>-<version>`, lowercased. */
const FORGE_EXTENSION_ID = 'Efsoo.forge-llm';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/;

/**
 * Compare two versions: >0 when `a` is newer. Segments compare numerically, so
 * `0.17.9` is older than `0.17.10` — a plain string compare would say the
 * opposite, and that is the mistake this module exists to avoid. A version with
 * a pre-release or build suffix (`-dev`, `+local`) is older than the same
 * version without one; two suffixed versions compare as strings.
 * `undefined` when either side is not a version, so a half-installed folder
 * never looks like an upgrade.
 */
export function compareSemver(a: string, b: string): number | undefined {
  const left = SEMVER.exec(a.trim());
  const right = SEMVER.exec(b.trim());
  if (!left || !right) return undefined;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return diff;
  }
  const leftSuffix = left[4] ?? '';
  const rightSuffix = right[4] ?? '';
  if (leftSuffix === rightSuffix) return 0;
  if (!leftSuffix) return 1;
  if (!rightSuffix) return -1;
  return leftSuffix < rightSuffix ? -1 : 1;
}

/**
 * Newest `<prefix><version>` folder in `extensionsDir`, or undefined. Folders
 * that do not start with `prefix`, are not directories, or do not carry a
 * parseable version are ignored: an unrelated extension, a `.obsolete` file or
 * a half-installed folder must not make Forge claim an upgrade that is not there.
 */
export function newestInstalledVersion(extensionsDir: string, prefix: string): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let newest: string | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const version = entry.name.slice(prefix.length);
    if (!SEMVER.test(version)) continue;
    if (newest === undefined) {
      newest = version;
      continue;
    }
    if ((compareSemver(version, newest) ?? 0) > 0) newest = version;
  }
  return newest;
}

/**
 * The sentence for a window that runs an older Forge than the newest folder in
 * `extensionsDir`, or undefined when it is current, ahead, or when either
 * version cannot be known. Built from the caller's own folder name so no path
 * is hardcoded: a portable install keeps its extensions somewhere else.
 */
export function staleBuildNoticeFor(
  runningVersion: string,
  extensionsDir: string,
  prefix: string,
): string | undefined {
  const installed = newestInstalledVersion(extensionsDir, prefix);
  if (installed === undefined) return undefined;
  if ((compareSemver(installed, runningVersion) ?? 0) <= 0) return undefined;
  return (
    `Forge ${installed} is installed; this window still runs ${runningVersion}. ` +
    'Reload the window.'
  );
}

/**
 * Recomputed on each call: the stale-build sentence for THIS window, or
 * undefined. Undefined is also the answer outside a real host — unit tests, a
 * development host that has not packaged the extension, or an extension folder
 * that does not carry its own version — so every caller must treat it as
 * "nothing to say", never as "up to date".
 */
export function detectStaleBuild(): string | undefined {
  const extension = vscode.extensions.getExtension(FORGE_EXTENSION_ID);
  const running = extension?.packageJSON?.['version'];
  const ownFolder = extension?.extensionPath;
  if (typeof running !== 'string' || typeof ownFolder !== 'string') return undefined;
  const versionSuffix = `-${running}`;
  const ownName = path.basename(ownFolder);
  // The installed layout is `<id>-<version>`; anything else (a dev host, an
  // unpacked VSIX) says nothing about what else is installed, so it says nothing.
  if (!ownName.endsWith(versionSuffix)) return undefined;
  return staleBuildNoticeFor(
    running,
    path.dirname(ownFolder),
    ownName.slice(0, ownName.length - versionSuffix.length) + '-',
  );
}

// In-memory for this window only. Detection and failure reporting still run on
// every call; dismissing a toast must survive scheduler retries. A new version
// pair produces a new notice and can warn again without reloading the window.
const shownStaleBuildWarnings = new Set<string>();

/** Show each version notice once per window, keeping the reload action. */
export async function showStaleBuildWarning(notice: string): Promise<void> {
  if (shownStaleBuildWarnings.has(notice)) return;
  // Remember before awaiting: another job can check while this toast is open.
  shownStaleBuildWarnings.add(notice);
  const picked = await vscode.window.showWarningMessage(notice, 'Reload Window');
  if (picked === 'Reload Window')
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

/**
 * The config-failure hook: when a config load or write fails, say if this
 * window is behind the installed build, because that is the difference between
 * "your config is wrong" and "this window is validating your config with last
 * night's rules". Logged every time; the toast is shown once per version pair
 * in this window, even when config failures or scheduler retries repeat.
 */
export function noticeStaleBuildOnConfigFailure(): void {
  const notice = detectStaleBuild();
  if (!notice) return;
  getLogger().warn(notice);
  void showStaleBuildWarning(notice);
}
