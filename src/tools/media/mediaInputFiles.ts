import * as fs from 'fs/promises';
import * as path from 'path';

const SUPPORTED_MUSIC_SOURCE_EXTENSIONS = new Set([
  '.aac',
  '.flac',
  '.m4a',
  '.mp3',
  '.oga',
  '.ogg',
  '.opus',
  '.wav',
  '.webm',
]);

/** Copy a user-selected file into this run's retained input directory. */
export async function copyRunInputFile(
  sourcePath: string,
  inputDir: string,
  prefix: 'source-still' | 'source-audio',
): Promise<string> {
  const extension = path.extname(sourcePath).toLowerCase() || '.bin';
  const destination = path.join(inputDir, `${prefix}${extension}`);
  await fs.copyFile(sourcePath, destination);
  return destination;
}

export function isSupportedMusicAudioPath(filePath: string): boolean {
  return SUPPORTED_MUSIC_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
