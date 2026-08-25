/** Extracts a human-readable detail string from a tool call's argument JSON. */
export function extractToolDetail(argsJson: string): string {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const model = args['model'];
    if (typeof model === 'string') {
      const focus = args['focus'];
      return typeof focus === 'string' ? `${model} · ${focus}` : model;
    }
    const path = args['path'] ?? args['file_path'] ?? args['directory'];
    if (typeof path === 'string') return path.split(/[\\/]/).pop() ?? path;
    const cmd = args['command'];
    if (typeof cmd === 'string') {
      const rawArgs = args['args'];
      const commandArgs = Array.isArray(rawArgs)
        ? rawArgs.filter((arg): arg is string => typeof arg === 'string')
        : [];
      return [cmd, ...commandArgs].map(displayArgument).join(' ');
    }
    const short = args['query'] ?? args['pattern'] ?? args['message'] ?? args['text'];
    if (typeof short === 'string') return short.length > 50 ? short.slice(0, 50) + '…' : short;
  } catch {
    /* malformed args — show nothing */
  }
  return '';
}

function displayArgument(value: string): string {
  return /\s/u.test(value) ? JSON.stringify(value) : value;
}
