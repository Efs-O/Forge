// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageAttachment } from '../../webview-ui/src/messageOps';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const postMessage = vi.fn();
(
  globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }
).acquireVsCodeApi = () => ({ postMessage });

const React = (await import('react')).default;
const { MessageAttachments } = await import('../../webview-ui/src/components/MessageAttachments');
const { ImageLightbox } = await import('../../webview-ui/src/components/ImageLightbox');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  postMessage.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const image: MessageAttachment = {
  name: 'screenshot.png',
  mediaType: 'image/png',
  bytes: 1234,
  src: 'data:image/png;base64,AAAA',
  relativePath: 'conv-1/shot.png',
};

const textFile: MessageAttachment = {
  name: 'notes.txt',
  mediaType: 'text/plain',
  bytes: 50,
  src: '',
  relativePath: 'conv-1/notes.txt',
};

describe('MessageAttachments', () => {
  it('expands an image in a lightbox on click, without posting to the host', () => {
    act(() => {
      root.render(React.createElement(MessageAttachments, { attachments: [image] }));
    });

    const thumbnail = container.querySelector<HTMLButtonElement>('.msg-attachment.is-image');
    expect(thumbnail).not.toBeNull();

    act(() => {
      thumbnail!.click();
    });

    const lightbox = document.body.querySelector('.lightbox-overlay');
    expect(lightbox).not.toBeNull();
    expect(document.body.querySelector('.lightbox-image')?.getAttribute('src')).toBe(image.src);
    // The image is viewed in place — it does not hand off to VS Code.
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('closes the lightbox on Escape', () => {
    act(() => {
      root.render(React.createElement(MessageAttachments, { attachments: [image] }));
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('.msg-attachment.is-image')!.click();
    });
    expect(document.body.querySelector('.lightbox-overlay')).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(document.body.querySelector('.lightbox-overlay')).toBeNull();
  });

  it('calls onClose once when the close button is clicked', () => {
    const onClose = vi.fn();
    act(() => {
      root.render(React.createElement(ImageLightbox, { attachment: image, onClose }));
    });

    act(() => {
      document.body.querySelector<HTMLButtonElement>('.lightbox-close')!.click();
    });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('still posts openAttachment for a non-image file', () => {
    act(() => {
      root.render(React.createElement(MessageAttachments, { attachments: [textFile] }));
    });

    const chip = container.querySelector<HTMLButtonElement>('.msg-attachment:not(.is-image)');
    expect(chip).not.toBeNull();

    act(() => {
      chip!.click();
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'openAttachment',
      relativePath: textFile.relativePath,
    });
    expect(document.body.querySelector('.lightbox-overlay')).toBeNull();
  });

  it('leaves a non-image chip without a relativePath disabled', () => {
    act(() => {
      root.render(
        React.createElement(MessageAttachments, {
          attachments: [{ ...textFile, relativePath: undefined }],
        }),
      );
    });

    const chip = container.querySelector<HTMLButtonElement>('.msg-attachment');
    expect(chip).not.toBeNull();
    expect(chip!.disabled).toBe(true);
  });

  it('leaves a non-image chip with an empty relativePath disabled', () => {
    act(() => {
      root.render(
        React.createElement(MessageAttachments, {
          attachments: [{ ...textFile, relativePath: '' }],
        }),
      );
    });

    const chip = container.querySelector<HTMLButtonElement>('.msg-attachment');
    expect(chip).not.toBeNull();
    expect(chip!.disabled).toBe(true);
  });
});
