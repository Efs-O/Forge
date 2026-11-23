import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vsceCli = join(root, 'node_modules', '@vscode', 'vsce', 'vsce');

const ALLOW_LIST = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE.txt',
  'LICENSE',
  'NOTICE',
  'AI_SETUP.md',
  'docs/MEDIA.md',
  'assets/icon.svg',
  'assets/publisher-logo.png',
  'assets/readme/**',
  'config/config.example.yaml',
  'config/contact-instructions.example.md',
  'config/starter/**',
  'config/templates/**',
  'dist/extension.js',
  'dist/uninstall.js',
  'dist/node_modules/**',
  'dist/pdfjs/pdf.mjs',
  'dist/pdfjs/pdf.worker.mjs',
  'dist/webview/**',
  'resources/media/media_job.py',
  'resources/media/media_comfy.py',
  'resources/media/video_ltx25.py',
  'resources/media/video_h3.py',
  'resources/media/video_h3_blueprint.py',
  'resources/media/video_ltx25_api_skeleton.json',
  'resources/media/music_ace.py',
  'resources/media/music_sa3.py',
  'resources/media/music_analyze.py',
  'resources/skills/**',
  'resources/tips/CODING_TIPS.md',
  'resources/instructions/FORGE.starter.md',
];

const REQUIRED_VSIX_FILES = [
  'resources/media/media_job.py',
  'resources/media/media_comfy.py',
  'resources/media/video_ltx25.py',
  'resources/media/video_h3.py',
  'resources/media/video_h3_blueprint.py',
  'resources/media/video_ltx25_api_skeleton.json',
  'resources/media/music_ace.py',
  'resources/media/music_sa3.py',
  'resources/media/music_analyze.py',
  'resources/skills/blender/SKILL.md',
  'resources/skills/video-clip/SKILL.md',
  'resources/skills/music-track/SKILL.md',
  'resources/tips/CODING_TIPS.md',
  'resources/instructions/FORGE.starter.md',
];

/** Return VSIX entries that are not explicitly approved for shipping. */
export function findUnexpectedVsixFiles(files) {
  return files.filter((file) => {
    const lower = file.toLowerCase();
    if (file.startsWith('skills-lab/')) return true;
    if (lower.split('/').includes('__pycache__') || lower.endsWith('.pyc') || lower.endsWith('.log'))
      return true;
    return !ALLOW_LIST.some((pattern) => {
      if (pattern.endsWith('/**')) return file.startsWith(`${pattern.slice(0, -3)}/`);
      return file === pattern;
    });
  });
}

/** Runtime adapters, their graph skeleton and shipped skills must ship. */
export function findMissingRequiredVsixFiles(files) {
  return REQUIRED_VSIX_FILES.filter((file) => !files.includes(file));
}

function checkVsixContents() {
  const listing = execFileSync(process.execPath, [vsceCli, 'ls', '--no-dependencies'], {
    cwd: root,
    encoding: 'utf8',
  });
  const files = listing.split(/\r?\n/u).filter(Boolean);
  const unexpected = findUnexpectedVsixFiles(files);
  if (unexpected.length) {
    console.error(
      `VSIX contents allow-list rejected ${unexpected.length} file(s):\n` +
        unexpected
          .map(
            (file) =>
              `- ${file}: delete it, add it to .vscodeignore, or, if it should ship, add it to the allow-list in scripts/check-vsix-contents.mjs.`,
          )
          .join('\n'),
    );
    process.exitCode = 1;
    return;
  }
  const missing = findMissingRequiredVsixFiles(files);
  if (missing.length) {
    console.error(`VSIX contents are missing required media files:\n${missing.map((file) => `- ${file}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`VSIX contents allow-list passed (${files.length} files).`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  checkVsixContents();
}
