import * as fsp from 'fs/promises';
import { z } from 'zod';
import { isTextMediaType, mediaTypeForPath } from './TelegramInboundMapping';
import type { RemoteInboundAttachment } from './types';

type TelegramCall = (
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;
type Fetch = typeof fetch;

interface TelegramDownloadDependencies {
  call: TelegramCall;
  fetchImpl: Fetch;
  token: string;
}

const TelegramFileSchema = z.object({ file_path: z.string().min(1) });

export async function downloadTelegramAttachment(
  attachment: RemoteInboundAttachment,
  dependencies: TelegramDownloadDependencies,
): Promise<RemoteInboundAttachment> {
  if (!attachment.providerFileId) throw new Error('Telegram attachment has no file id.');
  const file = TelegramFileSchema.parse(
    await dependencies.call('getFile', { file_id: attachment.providerFileId }),
  );
  const response = await dependencies.fetchImpl(
    `https://api.telegram.org/file/bot${dependencies.token}/${file.file_path}`,
  );
  if (!response.ok) throw new Error(`Telegram file download HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    ...attachment,
    // Decode only text. Binary attachments stay lossless as base64.
    data: isTextMediaType(attachment.mediaType) ? bytes.toString('utf8') : bytes.toString('base64'),
  };
}

export async function downloadTelegramAttachmentToFile(
  providerFileId: string,
  targetPath: string,
  signal: AbortSignal | undefined,
  dependencies: TelegramDownloadDependencies,
): Promise<{ bytes: number; mediaType: string }> {
  const file = TelegramFileSchema.parse(
    await dependencies.call('getFile', { file_id: providerFileId }, signal),
  );
  const response = await dependencies.fetchImpl(
    `https://api.telegram.org/file/bot${dependencies.token}/${file.file_path}`,
  );
  if (!response.ok) throw new Error(`Telegram file download HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await fsp.writeFile(targetPath, bytes);
  return { bytes: bytes.length, mediaType: mediaTypeForPath(file.file_path) };
}
