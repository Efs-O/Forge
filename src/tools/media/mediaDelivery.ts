import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { MAX_FILE_DELIVERY_BYTES } from '../../util/fileDeliveryValidation';

export type MediaDeliveryKind = 'video' | 'audio';

export async function prepareTelegramPreview(
  sourcePath: string,
  kind: MediaDeliveryKind,
  ffmpeg: string,
  deps: {
    stat?: typeof fs.stat;
    run?: (command: string, args: readonly string[]) => Promise<void>;
  } = {},
): Promise<string | undefined> {
  const stat = deps.stat ?? fs.stat;
  const source = await stat(sourcePath);
  if (source.size <= MAX_FILE_DELIVERY_BYTES) return undefined;
  const parsed = path.parse(sourcePath);
  const extension = kind === 'video' ? '.mp4' : '.mp3';
  const previewPath = path.join(parsed.dir, `${parsed.name}.telegram-preview${extension}`);
  const args =
    kind === 'video'
      ? [
          '-y',
          '-i',
          sourcePath,
          '-t',
          '15',
          '-vf',
          'scale=1280:-2',
          '-an',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '30',
          previewPath,
        ]
      : [
          '-y',
          '-i',
          sourcePath,
          '-t',
          '45',
          '-vn',
          '-c:a',
          'libmp3lame',
          '-b:a',
          '96k',
          previewPath,
        ];
  await (deps.run ?? runFfmpeg)(ffmpeg, args);
  const preview = await stat(previewPath);
  if (!preview.isFile() || preview.size === 0 || preview.size > MAX_FILE_DELIVERY_BYTES) {
    throw new Error(`ffmpeg did not make a Telegram-sized ${kind} preview.`);
  }
  return previewPath;
}

export function workspaceRelativePath(filePath: string, workspaceRoot: string): string | undefined {
  const relative = path.relative(workspaceRoot, filePath);
  if (!relative || relative === '.' || path.isAbsolute(relative)) return undefined;
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) return undefined;
  return relative.split(path.sep).join(path.posix.sep);
}

function runFfmpeg(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
      timeout: 120_000,
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg preview exited with code ${String(code)}.`));
    });
  });
}
