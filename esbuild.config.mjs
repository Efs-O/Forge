import * as esbuild from 'esbuild';
import { argv } from 'process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

const watchMode = argv.includes('--watch');
const buildAll = argv.includes('--all');
const webviewOnly = argv.includes('--webview');
const release = argv.includes('--release');

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
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
  'webview-ui/styles/tabs.css',
  'webview-ui/styles/sessions-panel.css',
  'webview-ui/styles/messages.css',
  'webview-ui/styles/tool-rows.css',
  'webview-ui/styles/diff.css',
  'webview-ui/styles/highlight.css',
  'webview-ui/styles/input.css',
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
