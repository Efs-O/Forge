import React, { useEffect, useRef } from 'react';
import type { MessageAttachment } from '../messageOps';

interface Props {
  attachment: MessageAttachment;
  onClose: () => void;
}

/**
 * Full-size view of a transcript image, in place of the VS Code preview it
 * replaced. The sidebar is too narrow to read a screenshot at thumbnail size,
 * so a click expands it to the viewport rather than opening a second window.
 *
 * Closes on Escape, a click on the dimmed backdrop, or the explicit button —
 * the three ways a user expects a lightbox to dismiss. The image itself does
 * not close on click, so an accidental tap on the picture keeps it open.
 */
export function ImageLightbox({ attachment, onClose }: Props): React.ReactElement {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Move focus into the dialog so Escape is reachable and the close button is
    // the first tab stop — the same contract the confirmation dialog relies on.
    closeRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="lightbox-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${attachment.name}`}
      onClick={onClose}
    >
      <button
        ref={closeRef}
        type="button"
        className="lightbox-close"
        onClick={(event) => {
          // The button is inside the backdrop. Prevent the same click from
          // invoking the close callback a second time on the overlay.
          event.stopPropagation();
          onClose();
        }}
        aria-label="Close image"
        title="Close (Esc)"
      >
        ×
      </button>
      <img
        className="lightbox-image"
        src={attachment.src}
        alt={attachment.name}
        onClick={(event) => event.stopPropagation()}
      />
      <div className="lightbox-caption" onClick={(event) => event.stopPropagation()}>
        {attachment.name}
      </div>
    </div>
  );
}
