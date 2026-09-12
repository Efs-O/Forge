import React, { useState } from 'react';
import type { MessageAttachment } from '../messageOps';
import { vscode } from '../vscode';
import { shortenName } from './AttachmentTray';
import { ImageLightbox } from './ImageLightbox';

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
 * expands it in a lightbox over the sidebar — the column is too narrow to read
 * a screenshot at thumbnail size, and a second window is a worse viewer than a
 * full-size view right here.
 *
 * Non-image files have no thumbnail to expand, so a click still hands them to
 * VS Code's own viewer. A row with no `relativePath` has not been persisted yet
 * (the local echo of a prompt still in flight); a non-image chip then shows but
 * does not offer to open. An image is always expandable — its bytes are in hand
 * as a data URL even before the host persists it.
 */
export function MessageAttachments({
  attachments,
}: {
  attachments: MessageAttachment[];
}): React.ReactElement | null {
  const [expanded, setExpanded] = useState<MessageAttachment | null>(null);

  if (!attachments.length) return null;
  return (
    <>
      <div className="msg-attachments">
        {attachments.map((attachment, index) => {
          const isImage = attachment.mediaType.startsWith('image/') && attachment.src !== '';
          const openable = isImage || attachment.relativePath !== undefined;
          const label = `${attachment.name} — ${sizeLabel(attachment.bytes)}`;
          const onClick = (): void => {
            if (isImage) {
              setExpanded(attachment);
              return;
            }
            if (attachment.relativePath) {
              vscode.postMessage({ type: 'openAttachment', relativePath: attachment.relativePath });
            }
          };
          return (
            <button
              key={`${attachment.name}-${index}`}
              type="button"
              className={`msg-attachment${isImage ? ' is-image' : ''}`}
              title={isImage ? `${label} — click to expand` : openable ? `${label} — click to open` : label}
              onClick={onClick}
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
      {expanded && <ImageLightbox attachment={expanded} onClose={() => setExpanded(null)} />}
    </>
  );
}
