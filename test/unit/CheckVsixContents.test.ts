import { describe, expect, it } from 'vitest';
import { findUnexpectedVsixFiles } from '../../scripts/check-vsix-contents.mjs';

const todaysFiles = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE.txt',
  'LICENSE',
  'NOTICE',
  'AI_SETUP.md',
  'FORGE.md.example',
  'assets/icon.svg',
  'assets/publisher-logo.png',
  'assets/readme/model-picker.jpg',
  'config/config.example.yaml',
  'config/contact-instructions.example.md',
  'config/starter/ollama.yaml',
  'config/templates/execute.njk',
  'dist/extension.js',
  'dist/node_modules/playwright-core/index.js',
  'dist/pdfjs/pdf.mjs',
  'dist/pdfjs/pdf.worker.mjs',
  'dist/webview/index.js',
  'resources/skills/hf-download/SKILL.md',
];

describe('VSIX contents allow-list', () => {
  it('allows the intended extension files', () => {
    expect(findUnexpectedVsixFiles(todaysFiles)).toEqual([]);
  });

  it('reports every unapproved log and Python cache entry', () => {
    expect(
      findUnexpectedVsixFiles([
        ...todaysFiles,
        'ci-b.log',
        '.pytest_cache/v/cache/nodeids',
        'resources/skills/x/__pycache__/a.pyc',
      ]),
    ).toEqual(['ci-b.log', '.pytest_cache/v/cache/nodeids', 'resources/skills/x/__pycache__/a.pyc']);
  });
});
