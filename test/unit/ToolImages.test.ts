import { describe, expect, it } from 'vitest';
import {
  IMAGE_SEARCH_THUMBNAILS_PREFIX,
  RENDERED_IMAGE_PREFIX,
} from '../../src/sidebar/toolResultView';
import type { ActivityGroupItem } from '../../webview-ui/src/activityRows';
import type { AppMessage } from '../../webview-ui/src/messageOps';
import { groupImages, toolImages } from '../../webview-ui/src/toolImages';
import { screenshotFileUri } from '../../webview-ui/src/workspaceRootUri';

function toolMessage(toolName: string, toolResult: string, extra: Partial<AppMessage> = {}): AppMessage {
  return {
    id: toolName,
    role: 'tool',
    content: toolName,
    toolName,
    toolResult,
    ...extra,
  };
}

describe('toolImages', () => {
  it('returns the saved workspace image from generate_image', () => {
    expect(
      toolImages(
        toolMessage(
          'generate_image',
          'Generated image saved to generated-images/fox.png (image/png, 130 bytes).',
        ),
      ),
    ).toEqual([{ kind: 'workspace', path: 'generated-images/fox.png' }]);
  });

  it('returns every image_search thumbnail in order, with its optional original', () => {
    const result =
      `${IMAGE_SEARCH_THUMBNAILS_PREFIX}` +
      '.forge/image-search/c1/one.jpg <https://images.example/one.jpg>, ' +
      '.forge/image-search/c1/two.png';
    expect(toolImages(toolMessage('image_search', result))).toEqual([
      {
        kind: 'workspace',
        path: '.forge/image-search/c1/one.jpg',
        original: 'https://images.example/one.jpg',
      },
      { kind: 'workspace', path: '.forge/image-search/c1/two.png' },
    ]);
  });

  it.each(['browser_screenshot', 'desktop_capture'])('returns the %s path as a screenshot', (name) => {
    const result = 'Capture complete. Saved to C:\\Users\\test\\.forge\\screenshots\\c1\\shot.png.';
    expect(toolImages(toolMessage(name, result))).toEqual([
      { kind: 'screenshot', path: 'C:\\Users\\test\\.forge\\screenshots\\c1\\shot.png' },
    ]);
  });

  it('returns an image-mode rendered page as a workspace image', () => {
    expect(
      toolImages(
        toolMessage(
          'render_html_to_image',
          `${RENDERED_IMAGE_PREFIX}generated-images/page.png (PNG, 130 bytes) at 1024x768.`,
        ),
      ),
    ).toEqual([{ kind: 'workspace', path: 'generated-images/page.png' }]);
  });

  it('does not return failed tool images', () => {
    expect(
      toolImages(
        toolMessage('generate_image', 'Generated image saved to generated-images/fox.png (PNG)', {
          toolIsError: true,
        }),
      ),
    ).toEqual([]);
  });
});

describe('groupImages', () => {
  it('flattens all attempt images and keeps call order', () => {
    const items: ActivityGroupItem[] = [
      {
        kind: 'step',
        step: {
          attempts: [
            {
              tools: [
                toolMessage(
                  'image_search',
                  `${IMAGE_SEARCH_THUMBNAILS_PREFIX}.forge/image-search/c1/one.jpg, .forge/image-search/c1/two.jpg`,
                ),
                toolMessage(
                  'render_html_to_image',
                  `${RENDERED_IMAGE_PREFIX}generated-images/page.png (PNG, 1 byte)`,
                ),
              ],
            },
          ],
          diffs: [],
        },
      },
      {
        kind: 'step',
        step: {
          attempts: [
            {
              tools: [
                toolMessage(
                  'generate_image',
                  'Generated image saved to generated-images/final.png (PNG, 1 byte)',
                ),
              ],
            },
          ],
          diffs: [],
        },
      },
    ];
    expect(groupImages(items).map((image) => image.path)).toEqual([
      '.forge/image-search/c1/one.jpg',
      '.forge/image-search/c1/two.jpg',
      'generated-images/page.png',
      'generated-images/final.png',
    ]);
  });
});

describe('screenshotFileUri', () => {
  it('maps an absolute path inside the screenshot tree to its webview URI', () => {
    expect(
      screenshotFileUri(
        'https://file.vscode-resource/screenshots',
        'C:\\Users\\test\\.forge\\screenshots\\conv 1\\shot (1).png',
      ),
    ).toBe('https://file.vscode-resource/screenshots/conv%201/shot%20(1).png');
  });

  it('does not map paths outside the screenshot tree or traversal paths', () => {
    expect(
      screenshotFileUri('https://file.vscode-resource/screenshots', 'C:\\Users\\test\\other.png'),
    ).toBeUndefined();
    expect(
      screenshotFileUri(
        'https://file.vscode-resource/screenshots',
        '/home/test/.forge/screenshots/../secret.png',
      ),
    ).toBeUndefined();
  });
});
