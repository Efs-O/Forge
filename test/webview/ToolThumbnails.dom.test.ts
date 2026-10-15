// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppMessage } from '../../webview-ui/src/messageOps';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import('react');
const { ToolRowThumbnails } = await import('../../webview-ui/src/components/ToolThumbnails');
const { ScreenshotsUriContext } = await import('../../webview-ui/src/workspaceRootUri');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ToolRowThumbnails screenshot', () => {
  it('replaces a failed screenshot image with the missing-file placeholder', () => {
    const message: AppMessage = {
      id: 'screenshot',
      role: 'tool',
      content: 'browser_screenshot',
      toolName: 'browser_screenshot',
      toolResult:
        'Screenshot complete. Saved to C:\\Users\\test\\.forge\\screenshots\\conv1\\capture.png.',
      toolResultTotal: 100,
    };
    act(() => {
      root.render(
        React.createElement(
          ScreenshotsUriContext.Provider,
          { value: 'https://file.vscode-resource/screenshots' },
          React.createElement(ToolRowThumbnails, { message }),
        ),
      );
    });

    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe(
      'https://file.vscode-resource/screenshots/conv1/capture.png',
    );
    act(() => image!.dispatchEvent(new Event('error')));

    expect(container.querySelector('.tool-image-missing')?.textContent).toBe(
      'image no longer on disk',
    );
    expect(container.querySelector('img')).toBeNull();
  });
});
