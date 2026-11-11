import { describe, expect, it } from 'vitest';
import {
  findMissingRequiredVsixFiles,
  findUnexpectedVsixFiles,
} from '../../scripts/check-vsix-contents.mjs';

const todaysFiles = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE.txt',
  'LICENSE',
  'NOTICE',
  'AI_SETUP.md',
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
  'resources/media/media_job.py',
  'resources/media/media_comfy.py',
  'resources/media/video_ltx25.py',
  'resources/media/video_h3.py',
  'resources/media/video_h3_blueprint.py',
  'resources/media/video_ltx25_api_skeleton.json',
  'resources/media/music_ace.py',
  'resources/media/music_sa3.py',
  'resources/media/music_analyze.py',
  'resources/skills/video-clip/SKILL.md',
  'resources/skills/music-track/SKILL.md',
];

describe('VSIX contents allow-list', () => {
  it('allows the intended extension files', () => {
    expect(findUnexpectedVsixFiles(todaysFiles)).toEqual([]);
    expect(findMissingRequiredVsixFiles(todaysFiles)).toEqual([]);
  });

  it('fails when a media adapter, graph skeleton or media skill is missing', () => {
    expect(findMissingRequiredVsixFiles(['resources/media/media_job.py'])).toEqual(
      expect.arrayContaining([
        'resources/media/video_ltx25_api_skeleton.json',
        'resources/skills/video-clip/SKILL.md',
        'resources/skills/music-track/SKILL.md',
      ]),
    );
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

  it('refuses lab skills in the packaged extension', () => {
    expect(findUnexpectedVsixFiles(['skills-lab/media-inspect/SKILL.md'])).toEqual([
      'skills-lab/media-inspect/SKILL.md',
    ]);
  });
});
