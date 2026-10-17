import { z } from 'zod';
import * as vscode from 'vscode';
import type { HostToWebview } from './messageBridge';

export const ActivityViewModeSchema = z.enum(['grouped', 'compact', 'full']);
export type ActivityViewMode = z.infer<typeof ActivityViewModeSchema>;
export const ThinkingDisplayModeSchema = z.enum(['preview', 'open', 'collapsed']);
export type ThinkingDisplayMode = z.infer<typeof ThinkingDisplayModeSchema>;

export function parseActivityViewMode(
  value: unknown,
): { success: true; mode: ActivityViewMode } | { success: false; received: string } {
  const parsed = ActivityViewModeSchema.safeParse(value);
  if (parsed.success) return { success: true, mode: parsed.data };
  return { success: false, received: describeSettingValue(value) };
}

export function publishActivityView(
  value: unknown,
  post: (message: HostToWebview) => void,
): string | undefined {
  const parsed = parseActivityViewMode(value);
  const mode = parsed.success ? parsed.mode : 'full';
  post({ type: 'activityView', mode });
  if (parsed.success) return undefined;
  return (
    `Forge: invalid forge.sidebar.activityView value ${parsed.received}. ` +
    'Accepted values are grouped, compact, and full. Using full view.'
  );
}

export function postActivityViewSetting(
  post: (message: HostToWebview) => void,
): string | undefined {
  const activityView: unknown = vscode.workspace
    .getConfiguration('forge.sidebar')
    .get('activityView');
  const thinkingDisplay: unknown = vscode.workspace
    .getConfiguration('forge')
    .get('thinkingDisplay');
  const notices = [
    publishActivityView(activityView, post),
    publishThinkingDisplay(thinkingDisplay, post),
  ].filter((notice): notice is string => Boolean(notice));
  return notices.length > 0 ? notices.join('\n') : undefined;
}

export function watchActivityViewConfiguration(
  view: vscode.WebviewView,
  post: (message: HostToWebview) => void,
): void {
  const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      !event.affectsConfiguration('forge.sidebar.activityView') &&
      !event.affectsConfiguration('forge.thinkingDisplay')
    ) {
      return;
    }
    const notice = postActivityViewSetting(post);
    if (notice) post({ type: 'notice', message: notice });
  });
  view.onDidDispose(() => subscription.dispose());
}

export function parseThinkingDisplayMode(
  value: unknown,
): { success: true; mode: ThinkingDisplayMode } | { success: false; received: string } {
  const parsed = ThinkingDisplayModeSchema.safeParse(value);
  if (parsed.success) return { success: true, mode: parsed.data };
  return { success: false, received: describeSettingValue(value) };
}

export function publishThinkingDisplay(
  value: unknown,
  post: (message: HostToWebview) => void,
): string | undefined {
  const parsed = parseThinkingDisplayMode(value);
  const mode = parsed.success ? parsed.mode : 'preview';
  post({ type: 'thinkingDisplay', mode });
  if (parsed.success) return undefined;
  return (
    `Forge: invalid forge.thinkingDisplay value ${parsed.received}. ` +
    'Accepted values are preview, open, and collapsed. Using preview.'
  );
}

function describeSettingValue(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
