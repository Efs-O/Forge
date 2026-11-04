import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_FILE_DELIVERY_BYTES } from '../../src/util/fileDeliveryValidation';
import { prepareTelegramPreview, workspaceRelativePath } from '../../src/tools/media/mediaDelivery';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function tempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-media-delivery-'));
  directories.push(directory);
  return directory;
}

describe('media Telegram delivery helpers', () => {
  it('creates a bounded ffmpeg video preview only when the source exceeds Telegram size', async () => {
    const directory = await tempDirectory();
    const source = path.join(directory, 'clip.mp4');
    const handle = await fs.open(source, 'w');
    await handle.truncate(MAX_FILE_DELIVERY_BYTES + 1);
    await handle.close();
    const commands: Array<{ command: string; args: readonly string[] }> = [];

    const preview = await prepareTelegramPreview(source, 'video', 'ffmpeg', {
      run: async (command, args) => {
        commands.push({ command, args });
        await fs.writeFile(args.at(-1) as string, 'preview');
      },
    });

    expect(preview).toBe(path.join(directory, 'clip.telegram-preview.mp4'));
    expect(commands[0]?.command).toBe('ffmpeg');
    expect(commands[0]?.args).toEqual(
      expect.arrayContaining(['-t', '15', '-vf', 'scale=1280:-2', '-an', '-c:v', 'libx264']),
    );
  });

  it('does not transcode an already-uploadable audio file', async () => {
    const directory = await tempDirectory();
    const source = path.join(directory, 'track.mp3');
    await fs.writeFile(source, 'small track');
    let ran = false;
    expect(
      await prepareTelegramPreview(source, 'audio', 'ffmpeg', {
        run: async () => {
          ran = true;
        },
      }),
    ).toBeUndefined();
    expect(ran).toBe(false);
  });

  it('returns a workspace-relative POSIX path and rejects paths outside the workspace', async () => {
    const workspace = path.join(await tempDirectory(), 'workspace');
    expect(workspaceRelativePath(path.join(workspace, 'media', 'clip.mp4'), workspace)).toBe(
      'media/clip.mp4',
    );
    expect(
      workspaceRelativePath(path.join(path.dirname(workspace), 'outside.mp4'), workspace),
    ).toBeUndefined();
  });
});
