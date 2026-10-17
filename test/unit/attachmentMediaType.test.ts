import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteAttachmentStore } from '../../src/remote/RemoteAttachmentStore';
import { attachmentMediaType } from '../../src/sidebar/attachmentLimits';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('attachment media type (U12-02)', () => {
  it('a text-kind file travels as text, whatever the extension-based label', () => {
    expect(attachmentMediaType('logo.svg', 'image/svg+xml')).toBe('text/plain');
    expect(attachmentMediaType('data.json', 'application/json')).toBe('text/plain');
    expect(attachmentMediaType('main.ts', 'video/mp2t')).toBe('text/plain');
    expect(attachmentMediaType('notes.md', 'text/markdown')).toBe('text/markdown');
    expect(attachmentMediaType('photo.png', 'image/png')).toBe('image/png');
    expect(attachmentMediaType('report.pdf', 'application/pdf')).toBe('application/pdf');
  });

  it('a Telegram .svg or .ts reaches the turn as its own text', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-remote-attach-'));
    roots.push(root);
    const store = new RemoteAttachmentStore(root);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const ts = 'export const x = 1;\n';
    const refs = await store.save('conv', 'req', [
      // TelegramDownloads sends +xml as UTF-8 and video/mp2t as base64.
      { name: 'logo.svg', mediaType: 'image/svg+xml', data: svg },
      { name: 'main.ts', mediaType: 'video/mp2t', data: Buffer.from(ts).toString('base64') },
    ]);
    expect(await store.load(refs)).toEqual([
      { name: 'logo.svg', mediaType: 'text/plain', data: svg },
      { name: 'main.ts', mediaType: 'text/plain', data: ts },
    ]);
  });
});
