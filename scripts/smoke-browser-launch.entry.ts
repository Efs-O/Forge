/**
 * B4 smoke entry: exercises the REAL `BrowserSessionManager.launch()` path
 * against a system browser channel. It is bundled with the extension's exact
 * esbuild options (bundle, platform node, external vscode, format cjs,
 * target node20) and run under plain node — so it proves the INLINED
 * `playwright-core` (not the node_modules copy) can actually start a system
 * browser. This is the gate before any browser tooling (plan §5 Phase 0.3).
 *
 * Headless so the smoke does not pop a window on the user's machine; the
 * launch path (find executable + spawn + newContext) is identical to headed.
 */
import { BrowserSessionManager, type BrowserChannel } from '../src/tools/browser/BrowserSessionManager';

const channel = ((process.argv[2] ?? 'chrome') as BrowserChannel) || 'chrome';

async function main(): Promise<void> {
  const mgr = new BrowserSessionManager();
  process.stdout.write(`[smoke] channel=${channel} headless=true\n`);
  const t0 = Date.now();
  const { version } = await mgr.launch({ channel, headless: true });
  process.stdout.write(`[smoke] launched ${version} in ${Date.now() - t0} ms\n`);
  await mgr.close();
  process.stdout.write(`[smoke] closed cleanly\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`[smoke] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
