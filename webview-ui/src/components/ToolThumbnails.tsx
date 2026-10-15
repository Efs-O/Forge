import React, { useCallback, useContext, useState } from 'react';
import type { ActivityGroupItem } from '../activityRows';
import type { AppMessage, MessageAttachment } from '../messageOps';
import { groupImages, toolImages, type ToolImage } from '../toolImages';
import {
  ScreenshotsUriContext,
  WorkspaceRootUriContext,
  screenshotFileUri,
  workspaceFileUri,
} from '../workspaceRootUri';
import { ImageLightbox } from './ImageLightbox';

interface ResolvedToolImage {
  attachment: MessageAttachment;
  original?: string;
}

function resolveImage(
  image: ToolImage,
  rootUri: string | undefined,
  screenshotsUri: string | undefined,
): ResolvedToolImage | undefined {
  const src =
    image.kind === 'workspace'
      ? rootUri && workspaceFileUri(rootUri, image.path)
      : screenshotsUri && screenshotFileUri(screenshotsUri, image.path);
  if (!src) return undefined;
  return {
    attachment: { name: image.path, mediaType: 'image/*', bytes: 0, src },
    ...(image.original ? { original: image.original } : {}),
  };
}

function ImageThumbnail({
  image,
  className,
  onClick,
}: {
  image: ResolvedToolImage;
  className: string;
  onClick: () => void;
}): React.ReactElement {
  const [missing, setMissing] = useState(false);
  return (
    <button
      type="button"
      className={className}
      title={missing ? 'image no longer on disk' : `${image.attachment.name} — click to expand`}
      aria-label={missing ? 'image no longer on disk' : `View ${image.attachment.name}`}
      disabled={missing}
      onClick={onClick}
    >
      {missing ? (
        <span className="tool-image-missing">image no longer on disk</span>
      ) : (
        <img
          src={image.attachment.src}
          alt={image.attachment.name}
          onError={() => setMissing(true)}
        />
      )}
    </button>
  );
}

function useResolvedImages(images: ToolImage[]): ResolvedToolImage[] {
  const rootUri = useContext(WorkspaceRootUriContext);
  const screenshotsUri = useContext(ScreenshotsUriContext);
  return images.flatMap((image) => {
    const resolved = resolveImage(image, rootUri, screenshotsUri);
    return resolved ? [resolved] : [];
  });
}

function Lightbox({
  image,
  onClose,
}: {
  image: ResolvedToolImage | undefined;
  onClose: () => void;
}): React.ReactElement | null {
  if (!image) return null;
  return (
    <ImageLightbox
      attachment={image.attachment}
      onClose={onClose}
      {...(image.original ? { originalUrl: image.original } : {})}
    />
  );
}

/** Thumbnails shared by full tool rows and the collapsed activity step. */
export function ToolRowThumbnails({ message }: { message: AppMessage }): React.ReactElement | null {
  const [expanded, setExpanded] = useState<number | null>(null);
  const closeExpanded = useCallback(() => setExpanded(null), []);
  const images = useResolvedImages(toolImages(message));
  if (images.length === 0) return null;
  const openImage = expanded === null ? undefined : images[expanded];

  return (
    <>
      <div className={`tool-row-thumbs${images.length > 1 ? ' is-grid' : ''}`}>
        {images.map((image, index) => (
          <ImageThumbnail
            key={`${image.attachment.name}:${index}`}
            image={image}
            className="tool-row-thumb"
            onClick={() => setExpanded(index)}
          />
        ))}
      </div>
      <Lightbox image={openImage} onClose={closeExpanded} />
    </>
  );
}

/** Folded strip for every image produced by a group's calls. */
export function GroupImageStrip({
  items,
  onMore,
}: {
  items: ActivityGroupItem[];
  onMore: () => void;
}): React.ReactElement | null {
  const [expanded, setExpanded] = useState<number | null>(null);
  const closeExpanded = useCallback(() => setExpanded(null), []);
  const images = useResolvedImages(groupImages(items));
  if (images.length === 0) return null;

  const capped = images.length > 6;
  const visible = capped ? images.slice(0, 5) : images;
  const openImage = expanded === null ? undefined : images[expanded];
  return (
    <>
      <div className="group-image-strip" aria-label={`${images.length} images`}>
        {visible.map((image, index) => (
          <ImageThumbnail
            key={`${image.attachment.name}:${index}`}
            image={image}
            className="tool-row-thumb group-image-thumb"
            onClick={() => setExpanded(index)}
          />
        ))}
        {capped && (
          <button type="button" className="group-image-more" onClick={onMore}>
            +{images.length - visible.length} more
          </button>
        )}
      </div>
      <Lightbox image={openImage} onClose={closeExpanded} />
    </>
  );
}
