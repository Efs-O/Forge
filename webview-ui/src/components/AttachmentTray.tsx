import React from 'react';
import type { AttachmentData } from '../../../src/sidebar/messageBridge';
import { MAX_ATTACHMENT_TOTAL_BYTES } from '../../../src/sidebar/attachmentLimits';
import { attachmentBytes } from './useAttachments';

interface Props {
  attachments: AttachmentData[];
  totalBytes: number;
  errors: string[];
  onRemove: (index: number) => void;
  onClear: () => void;
  onDismissErrors: () => void;
}

/** Show the budget only once it is close enough to matter. */
const BUDGET_VISIBLE_AT = 0.6;

/**
 * Middle-ellipsis: every file in a source tree ends in the part that identifies
 * it (`.ts` vs `.test.ts`), so trimming the tail is exactly the wrong end.
 */
export function shortenName(name: string, max = 18): string {
  if (name.length <= max) return name;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function extensionLabel(name: string): string {
  const extension = name.split('.').pop() ?? '';
  return extension.length && extension.length <= 4 ? extension.toUpperCase() : 'FILE';
}

const FileGlyph = (): React.ReactElement => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M9.5 1H4a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5V5zm0 1.5L12.5 5H10a.5.5 0 0 1-.5-.5z" />
  </svg>
);

export function AttachmentTray({
  attachments,
  totalBytes,
  errors,
  onRemove,
  onClear,
  onDismissErrors,
}: Props): React.ReactElement | null {
  if (!attachments.length && !errors.length) return null;
  const showBudget = totalBytes > MAX_ATTACHMENT_TOTAL_BYTES * BUDGET_VISIBLE_AT;

  return (
    <div id="attachment-tray">
      {errors.length > 0 && (
        <div className="attachment-errors" role="alert">
          <div className="attachment-error-list">
            {errors.map((message, i) => (
              <span key={i}>{message}</span>
            ))}
          </div>
          <button
            type="button"
            className="attachment-error-dismiss"
            onClick={onDismissErrors}
            title="Dismiss"
            aria-label="Dismiss attachment errors"
          >
            ×
          </button>
        </div>
      )}

      {attachments.length > 0 && (
        <>
          <div className="attachment-tiles">
            {attachments.map((item, i) => {
              const isImage = item.mediaType.startsWith('image/');
              const bytes = attachmentBytes(item);
              return (
                <div
                  key={`${item.name}-${i}`}
                  className={`attachment-tile${isImage ? ' is-image' : ''}`}
                  title={`${item.name} — ${sizeLabel(bytes)}`}
                >
                  <div className="attachment-preview">
                    {isImage ? (
                      <img src={`data:${item.mediaType};base64,${item.data}`} alt={item.name} />
                    ) : (
                      <>
                        <FileGlyph />
                        <span className="attachment-ext">{extensionLabel(item.name)}</span>
                      </>
                    )}
                  </div>
                  <div className="attachment-meta">
                    <span className="attachment-name">{shortenName(item.name)}</span>
                    <span className="attachment-size">{sizeLabel(bytes)}</span>
                  </div>
                  <button
                    type="button"
                    className="attachment-remove"
                    onClick={() => onRemove(i)}
                    title={`Remove ${item.name}`}
                    aria-label={`Remove ${item.name}`}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>

          {(showBudget || attachments.length > 1) && (
            <div className="attachment-footer">
              {showBudget && (
                <span className="attachment-budget">
                  {sizeLabel(totalBytes)} / {sizeLabel(MAX_ATTACHMENT_TOTAL_BYTES)}
                </span>
              )}
              {attachments.length > 1 && (
                <button type="button" className="attachment-clear" onClick={onClear}>
                  Clear all
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
