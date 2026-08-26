import type { AttachmentData } from './messageBridge';

/** Attachment limits apply at both picker and extension-host boundaries. */
export const MAX_ATTACHMENTS_PER_PROMPT = 10;
export const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_BYTES = 2 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'cs',
  'css',
  'go',
  'h',
  'hpp',
  'html',
  'java',
  'js',
  'json',
  'jsx',
  'kt',
  'md',
  'mdx',
  'php',
  'py',
  'rb',
  'rs',
  'sh',
  'sql',
  'svg',
  'toml',
  'ts',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml',
  'csv',
]);

export const ATTACHMENT_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,image/bmp,.c,.cc,.cpp,.cs,.css,.go,.h,.hpp,' +
  '.html,.java,.js,.json,.jsx,.kt,.md,.mdx,.php,.py,.rb,.rs,.sh,.sql,.svg,.toml,.ts,.tsx,' +
  '.txt,.xml,.yaml,.yml,.csv';

export function attachmentKind(name: string, mediaType: string): 'image' | 'text' | null {
  if (
    mediaType === 'image/png' ||
    mediaType === 'image/jpeg' ||
    mediaType === 'image/webp' ||
    mediaType === 'image/gif' ||
    mediaType === 'image/bmp'
  )
    return 'image';
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_EXTENSIONS.has(extension) ? 'text' : null;
}

export function attachmentLimitBytes(
  attachment: Pick<AttachmentData, 'name' | 'mediaType'>,
): number | null {
  const kind = attachmentKind(attachment.name, attachment.mediaType);
  if (kind === 'image') return MAX_IMAGE_ATTACHMENT_BYTES;
  if (kind === 'text') return MAX_TEXT_ATTACHMENT_BYTES;
  return null;
}
