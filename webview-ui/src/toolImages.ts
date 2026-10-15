import {
  generatedImagePath,
  imageSearchThumbnails,
  renderedImagePath,
  screenshotPath,
} from '../../src/sidebar/toolResultView';
import type { ActivityGroupItem } from './activityRows';
import { stepTools } from './activityRows';
import type { AppMessage } from './messageOps';

export interface ToolImage {
  kind: 'workspace' | 'screenshot';
  path: string;
  original?: string;
}

/** Every image recorded in one successful tool result, in result order. */
export function toolImages(message: AppMessage): ToolImage[] {
  if (message.role !== 'tool' || message.toolIsError) return [];
  const toolName = message.toolName ?? '';
  const result = message.toolResult ?? '';

  switch (toolName) {
    case 'generate_image': {
      const path = generatedImagePath(toolName, result);
      return path ? [{ kind: 'workspace', path }] : [];
    }
    case 'image_search':
      return imageSearchThumbnails(toolName, result).map(({ path, original }) => ({
        kind: 'workspace',
        path,
        ...(original ? { original } : {}),
      }));
    case 'browser_screenshot':
    case 'desktop_capture': {
      const path = screenshotPath(toolName, result);
      return path ? [{ kind: 'screenshot', path }] : [];
    }
    case 'render_html_to_image': {
      const path = renderedImagePath(toolName, result);
      return path ? [{ kind: 'workspace', path }] : [];
    }
    default:
      return [];
  }
}

/** Images from a group's tool calls, preserving call and per-result order. */
export function groupImages(items: ActivityGroupItem[]): ToolImage[] {
  return items.flatMap((item) =>
    item.kind === 'step' ? stepTools(item.step).flatMap(toolImages) : [],
  );
}
