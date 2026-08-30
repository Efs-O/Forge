/** Visible, conversation-addressed progress that may be mirrored to an authorized surface. */
export type AgentProgressEvent =
  | { conversationId: string; kind: 'commentary'; text: string }
  | { conversationId: string; kind: 'tool'; toolName: string }
  | { conversationId: string; kind: 'status'; text: string };

export type AgentProgressListener = (event: AgentProgressEvent) => void;

/** Redacts CLI tool arguments while retaining a useful user-facing milestone. */
export function summarizeCliProgress(cliName: string, detail: string): string {
  if (/^(Preparing|Finalizing) rollback checkpoint \(\d+\/\d+ files\)$/.test(detail)) {
    return detail;
  }
  if (detail.startsWith('Warning: external CLI rollback protection is disabled.')) {
    return 'External CLI rollback protection is disabled.';
  }
  const action = /^\[[^:\]]+:\s*([a-zA-Z_][a-zA-Z0-9_-]*)/.exec(detail)?.[1]?.toLowerCase();
  if (action === 'exec' || action === 'bash') return `${cliName}: running a command…`;
  if (action === 'edit' || action === 'write') return `${cliName}: editing files…`;
  if (action === 'read') return `${cliName}: reading files…`;
  if (action === 'grep' || action === 'glob') return `${cliName}: searching files…`;
  return `${cliName}: working…`;
}
