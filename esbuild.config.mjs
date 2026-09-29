import * as esbuild from 'esbuild';
import { argv } from 'process';
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';

const watchMode = argv.includes('--watch');
const buildAll = argv.includes('--all');
const webviewOnly = argv.includes('--webview');
const release = argv.includes('--release');

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // `vscode` is provided by the host. `playwright-core` is external (NOT
  // inlined) and shipped intact next to the bundle (dist/node_modules/): its
  // launcher does runtime file lookups (browsers.json, the optional
  // chromium-bidi require) relative to its package location, which break when
  // esbuild inlines the package. See docs/plans/BROWSER_DESKTOP_USE_TOOLS_PLAN.md §9.
  external: ['vscode', 'playwright-core'],
  // The agent-bus client script is a real file bundled as text (MESH_RUN_1_FINDINGS F1).
  // The Windows desktop driver is the same: a .ps1 bundled as text, written to a
  // temp file at driver start and spawned with `pwsh -File` (no script-text interpolation).
  loader: { '.sh': 'text', '.ps1': 'text' },
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: !release,
  minify: release,
};

const webviewConfig = {
  entryPoints: ['webview-ui/src/index.tsx'],
  bundle: true,
  outfile: 'dist/webview/main.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: !release,
  minify: release,
  jsx: 'automatic',
  jsxImportSource: 'react',
};

// Second webview entry point — the Model Manager editor-area panel
// (F7/§2.3). Separate bundle/CSS/HTML so it shares no state with the
// sidebar chat webview; see src/sidebar/modelManager/panelHtml.ts.
const modelManagerConfig = {
  entryPoints: ['webview-ui/src/modelManager/index.tsx'],
  bundle: true,
  outfile: 'dist/webview/modelManager.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: !release,
  minify: release,
  jsx: 'automatic',
  jsxImportSource: 'react',
};

const CSS_PARTIALS = [
  'webview-ui/styles/base.css',
  'webview-ui/styles/animations.css',
  'webview-ui/styles/layout.css',
  'webview-ui/styles/chat-header.css',
  'webview-ui/styles/sessions-panel.css',
  'webview-ui/styles/messages.css',
  'webview-ui/styles/tool-rows.css',
  'webview-ui/styles/diff.css',
  'webview-ui/styles/highlight.css',
  'webview-ui/styles/input.css',
  'webview-ui/styles/attachments.css',
  'webview-ui/styles/dialogs.css',
  'webview-ui/styles/model-selector.css',
  'webview-ui/styles/empty-state.css',
];

const MODEL_MANAGER_CSS_PARTIALS = [
  'webview-ui/styles/base.css',
  'webview-ui/styles/model-manager.css',
  'webview-ui/styles/model-manager-detail.css',
];

function copyWebviewAssets() {
  mkdirSync('dist/webview', { recursive: true });
  const css = CSS_PARTIALS.map((f) => readFileSync(f, 'utf8')).join('\n');
  writeFileSync('dist/webview/styles.css', css);
  copyFileSync('webview-ui/index.html', 'dist/webview/index.html');

  const modelManagerCss = MODEL_MANAGER_CSS_PARTIALS.map((f) => readFileSync(f, 'utf8')).join('\n');
  writeFileSync('dist/webview/modelManager.css', modelManagerCss);
  copyFileSync('webview-ui/modelManager.html', 'dist/webview/modelManager.html');
}

// B4: playwright-core is external and shipped intact next to the bundle, where
// the bundle's require('playwright-core') resolves it. Its launcher does runtime
// file lookups (browsers.json, the optional chromium-bidi require) relative to
// its package location, which break when inlined. Delete the old copy first so a
// stale/changed package never lingers in dist/. Its LICENSE/NOTICE ship with it.
function copyPlaywrightCore() {
  const src = 'node_modules/playwright-core';
  const dest = 'dist/node_modules/playwright-core';
  rmSync(dest, { recursive: true, force: true });
  mkdirSync('dist/node_modules', { recursive: true });
  cpSync(src, dest, { recursive: true });
}

async function build() {
  if (watchMode) {
    const extCtx = await esbuild.context(extensionConfig);
    const webCtx = await esbuild.context(webviewConfig);
    const mmCtx = await esbuild.context(modelManagerConfig);
    await Promise.all([extCtx.watch(), webCtx.watch(), mmCtx.watch()]);
    copyWebviewAssets();
    console.log('Watching for changes…');
    return;
  }

  if (webviewOnly) {
    await esbuild.build(webviewConfig);
    await esbuild.build(modelManagerConfig);
    copyWebviewAssets();
    console.log('Webview built.');
    return;
  }

  await esbuild.build(extensionConfig);
  console.log('Extension built.');
  copyPlaywrightCore();

  if (buildAll) {
    await esbuild.build(webviewConfig);
    await esbuild.build(modelManagerConfig);
    copyWebviewAssets();
    console.log('Webview built.');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
