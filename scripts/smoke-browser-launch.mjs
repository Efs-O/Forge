/**
 * Builds and runs the B4 browser-launch smoke (plan §5 Phase 0.3).
 *
 * Usage: node scripts/smoke-browser-launch.mjs [chrome|msedge|chromium]
 *
 * B4 finding (verified): playwright-core is NOT bundle-safe. Its launcher does
 * runtime file lookups (browsers.json, the optional chromium-bidi require)
 * relative to its package location, and both break when esbuild inlines the
 * package. So the extension build marks playwright-core EXTERNAL and ships the
 * intact package next to the bundle (dist/node_modules/), where the bundle's
 * require('playwright-core') resolves it. This smoke mirrors that packaging
 * exactly (same external, same copy) so it proves the packaged path, not the
 * dev node_modules.
 *
 * The smoke bundle output is underscore-prefixed (dist/_browser-smoke.js) so
 * .vscodeignore's `dist/_*` rule keeps it out of the VSIX.
 */
import * as esbuild from 'esbuild';
import { spawnSync } from 'child_process';
import { cpSync, mkdirSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const channel = process.argv[2] || 'chrome';

const outfile = path.join(root, 'dist', '_browser-smoke.js');

// Ship playwright-core next to the bundle so the external require resolves to
// the intact package (browsers.json + optional deps in place). Must mirror
// esbuild.config.mjs copyPlaywrightCore().
const pwSrc = path.join(root, 'node_modules', 'playwright-core');
const pwDest = path.join(root, 'dist', 'node_modules', 'playwright-core');
rmSync(pwDest, { recursive: true, force: true });
mkdirSync(path.dirname(pwDest), { recursive: true });
cpSync(pwSrc, pwDest, { recursive: true });
process.stdout.write(`[smoke] copied playwright-core -> ${path.relative(root, pwDest)}\n`);

await esbuild.build({
  entryPoints: [path.join(root, 'scripts', 'smoke-browser-launch.entry.ts')],
  bundle: true,
  outfile,
  // MUST stay in sync with esbuild.config.mjs extensionConfig.external.
  external: ['vscode', 'playwright-core'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  minify: false,
});
process.stdout.write(`[smoke] bundled -> ${path.relative(root, outfile)}\n`);

const res = spawnSync(process.execPath, [outfile, channel], { encoding: 'utf8' });
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);
process.exit(res.status ?? 1);
