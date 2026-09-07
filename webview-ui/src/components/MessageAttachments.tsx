import React from 'react';
import type { MessageAttachment } from '../messageOps';
import { vscode } from '../vscode';
import { shortenName } from './AttachmentTray';

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The files a prompt carried, under the bubble that sent them.
 *
 * Images render as thumbnails because that is the whole point: a chip reading
 * "screenshot.png" tells the reader nothing they did not already know, and the
 * transcript is the only place the conversation can be read back. Clicking one
 * hands it to VS Code, whose image preview already zooms and reports the real
 * dimensions -- reimplementing a lightbox in the sidebar would be a worse
 * viewer in a narrower column.
 *
 * A row with no `relativePath` has not been persisted yet (the local echo of a
 * prompt still in flight); it shows, but does not offer to open.
 */
export function MessageAttachments({
  attachments,
}: {
  attachments: MessageAttachment[];
}): React.ReactElement | null {
  if (!attachments.length) return null;
  return (
    <div className="msg-attachments">
      {attachments.map((attachment, index) => {
        const isImage = attachment.mediaType.startsWith('image/') && attachment.src !== '';
        const openable = attachment.relativePath !== undefined;
        const label = `${attachment.name} — ${sizeLabel(attachment.bytes)}`;
        const open = (): void => {
          if (!attachment.relativePath) return;
          vscode.postMessage({ type: 'openAttachment', relativePath: attachment.relativePath });
        };
        return (
          <button
            key={`${attachment.name}-${index}`}
            type="button"
            className={`msg-attachment${isImage ? ' is-image' : ''}`}
            title={openable ? `${label} — click to open` : label}
            onClick={open}
            disabled={!openable}
          >
            {isImage ? (
              <img src={attachment.src} alt={attachment.name} />
            ) : (
              <span className="msg-attachment-name">{shortenName(attachment.name, 24)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
