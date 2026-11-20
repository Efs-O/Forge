import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A temp folder of our own for a PowerShell child that compiles with `Add-Type`.
 *
 * `Add-Type -TypeDefinition` runs through .NET's CodeDom provider, which writes
 * five scratch files named after eight random characters - `cug3etsd.0.cs`,
 * `.dll`, `.err`, `.out`, `.cmdline` - into whatever `TMP`/`TEMP` the child
 * inherits. Left in the system temp they pile up there for the life of the
 * machine, and in the test suite they trip the temp guard
 * (`test/support/tempGuard.setup.ts`), which fails the whole test file that was
 * running when the child died. Dying is the normal outcome under load: both the
 * Restart Manager probe and the job keeper give the child three seconds, and a
 * cold PowerShell plus a compile spends them when the machine is busy.
 *
 * So every PowerShell child that compiles gets a folder this module owns, which
 * the caller removes once that child has exited. `~/.forge/job-keeper/` already
 * worked this way; this is that recipe, in one place, with the removal the
 * keeper could not do because its child outlived the call.
 */

/** How long a finished child's scratch folder waits before a later start prunes
 *  it — the backstop for a Forge process that died while its child was running. */
const SCRATCH_STALE_MS = 24 * 60 * 60 * 1000;

/** Remove scratch folders this module left more than a day ago. A live child
 *  writes here as it compiles, so its mtime keeps it alive. */
function pruneStaleScratch(root: string): void {
  const now = Date.now();
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith('ps-')) continue;
    const full = path.join(root, name);
    try {
      if (now - fs.statSync(full).mtimeMs > SCRATCH_STALE_MS) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // Another window may have removed it between the stat and the unlink.
    }
  }
}

export interface PowershellScratch {
  /** What to merge into the child's environment. Empty if no folder could be made. */
  env: Record<string, string>;
  /** Remove the folder once the child that used it has exited. Idempotent, and
   *  never throws: a folder this call cannot remove is the next start's to prune. */
  dispose: () => void;
}

/**
 * One scratch folder for one PowerShell compile.
 *
 * `folderName` is the leaf under `~/.forge/` that holds this caller's children,
 * so one caller's scratch is never another's to prune.
 */
export function powershellScratch(
  folderName: string,
  home: string = os.homedir(),
): PowershellScratch {
  let dir: string | undefined;
  try {
    const root = path.join(home, '.forge', folderName);
    fs.mkdirSync(root, { recursive: true });
    pruneStaleScratch(root);
    dir = path.join(root, `ps-${String(process.pid)}-${Date.now().toString(36)}`);
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // No folder of our own: the child writes where it always wrote, and the
    // caller still works.
    dir = undefined;
  }
  let removed = false;
  return {
    // TMP and TEMP are what .NET's Path.GetTempPath reads on Windows; TMPDIR is
    // the POSIX spelling, harmless to set and correct if the same child runs there.
    env: dir ? { TMP: dir, TEMP: dir, TMPDIR: dir } : {},
    dispose: () => {
      if (!dir || removed) return;
      removed = true;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Still locked, or already gone: the 24 h prune is the backstop.
      }
    },
  };
}
