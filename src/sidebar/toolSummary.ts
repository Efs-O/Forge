/** Extracts a short human-readable label from a tool call's argument JSON. */
export function extractToolDetail(argsJson: string): string {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const path = args['path'] ?? args['file_path'] ?? args['directory'];
    if (typeof path === 'string') return path.split(/[\\/]/).pop() ?? path;
    const cmd = args['command'];
    if (typeof cmd === 'string') return cmd.length > 50 ? cmd.slice(0, 50) + '…' : cmd;
    const short = args['query'] ?? args['pattern'] ?? args['message'] ?? args['text'];
    if (typeof short === 'string') return short.length > 50 ? short.slice(0, 50) + '…' : short;
  } catch { /* malformed args — show nothing */ }
  return '';
}
