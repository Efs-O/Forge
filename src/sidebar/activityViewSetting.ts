import { z } from 'zod';
import * as vscode from 'vscode';
import type { HostToWebview } from './messageBridge';

const ActivityViewModeSchema = z.enum(['grouped', 'compact', 'full']);
export type ActivityViewMode = z.infer<typeof ActivityViewModeSchema>;

export function parseActivityViewMode(
  value: unknown,
): { success: true; mode: ActivityViewMode } | { success: false; received: string } {
  const parsed = ActivityViewModeSchema.safeParse(value);
  if (parsed.success) return { success: true, mode: parsed.data };
  return { success: false, received: describeSettingValue(value) };
}

function publishActivityView(
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
  const value: unknown = vscode.workspace.getConfiguration('forge.sidebar').get('activityView');
  return publishActivityView(value, post);
}

export function watchActivityViewConfiguration(
  view: vscode.WebviewView,
  post: (message: HostToWebview) => void,
): void {
  const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('forge.sidebar.activityView')) return;
    const notice = postActivityViewSetting(post);
    if (notice) post({ type: 'notice', message: notice });
  });
  view.onDidDispose(() => subscription.dispose());
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
