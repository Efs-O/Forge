import * as esbuild from 'esbuild';
import { argv } from 'process';
import { copyFileSync, mkdirSync } from 'fs';

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
  target: 'node18',
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

function copyWebviewAssets() {
  mkdirSync('dist/webview', { recursive: true });
  copyFileSync('webview-ui/styles.css', 'dist/webview/styles.css');
  copyFileSync('webview-ui/index.html', 'dist/webview/index.html');
}

async function build() {
  if (watchMode) {
    const extCtx = await esbuild.context(extensionConfig);
    const webCtx = await esbuild.context(webviewConfig);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    copyWebviewAssets();
    console.log('Watching for changes…');
    return;
  }

  if (webviewOnly) {
    await esbuild.build(webviewConfig);
    copyWebviewAssets();
    console.log('Webview built.');
    return;
  }

  await esbuild.build(extensionConfig);
  console.log('Extension built.');

  if (buildAll) {
    await esbuild.build(webviewConfig);
    copyWebviewAssets();
    console.log('Webview built.');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
