/**
 * The detached watcher behind `stop_on_exit`. `deactivate()` cannot tell a
 * window reload from a window close, so it never runs `stop_command` itself:
 * it starts this watcher, which outlives the extension host, waits out the
 * grace period, and stops the server only if no live Forge window has taken a
 * lifecycle lease by then. A reloaded window re-acquires its lease during
 * activation (`onStartupFinished`), well inside the grace period.
 * See docs/plans/STRATA_LIFECYCLE_PLAN.md.
 */

/** Long enough for a reloaded window to activate; short enough to feel like "on close". */
export const STOP_GRACE_MS = 20_000;

// Runs under ELECTRON_RUN_AS_NODE, so plain Node with no bundle. argv after -e:
// leaseDir, graceMs, then the stop command's argv. A lease counts as live when
// its pid answers signal 0 (EPERM means alive but not ours).
const WATCHER_SCRIPT = `
const [leaseDir, graceMs, command, ...args] = process.argv.slice(1);
setTimeout(() => {
  const fs = require('fs'), path = require('path'), cp = require('child_process');
  let names = [];
  try { names = fs.readdirSync(leaseDir).filter((n) => n.endsWith('.json')); } catch {}
  const live = names.some((name) => {
    try {
      process.kill(JSON.parse(fs.readFileSync(path.join(leaseDir, name), 'utf8')).pid, 0);
      return true;
    } catch (error) {
      return error && error.code === 'EPERM';
    }
  });
  if (!live) cp.spawn(command, args, { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
}, Number(graceMs));
`;

export interface DeferredStopInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** The argv that runs the watcher with this host's own Node (Electron) binary. */
export function deferredStopInvocation(
  leaseDir: string,
  graceMs: number,
  stopCommand: readonly string[],
): DeferredStopInvocation {
  return {
    command: process.execPath,
    args: ['-e', WATCHER_SCRIPT, leaseDir, String(graceMs), ...stopCommand],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  };
}
