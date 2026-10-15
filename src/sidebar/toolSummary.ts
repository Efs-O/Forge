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
    if (typeof path === 'string') {
      const target = pathBasename(path);
      const edits = args['edits'];
      return target && Array.isArray(edits) && edits.length > 1
        ? `${target} · ${edits.length} edits`
        : target;
    }
    const paths = args['paths'];
    // A valid target may arrive either as the bulk-delete array or, from a
    // malformed call, as a string. Keep that string visible as supplied.
    if (typeof paths === 'string') return paths;
    if (Array.isArray(paths)) {
      const targets = paths
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .map(pathBasename);
      if (targets.length > 3) {
        return `${targets.slice(0, 3).join(', ')} +${targets.length - 3} more`;
      }
      return targets.join(', ');
    }
    const cmd = args['command'];
    if (typeof cmd === 'string') {
      const rawArgs = args['args'];
      const commandArgs = Array.isArray(rawArgs)
        ? rawArgs.filter((arg): arg is string => typeof arg === 'string')
        : [];
      // `command` is a whole command line for `shell`, so it is shown as typed;
      // quoting it hid the `cd … &&` prefix from the webview's label shortener.
      return [cmd, ...commandArgs.map(displayArgument)].join(' ');
    }
    const short =
      args['query'] ?? args['pattern'] ?? args['message'] ?? args['text'] ?? args['prompt'];
    if (typeof short === 'string') return short.length > 50 ? short.slice(0, 50) + '…' : short;
  } catch {
    /* malformed args — show nothing */
  }
  return '';
}

function pathBasename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function displayArgument(value: string): string {
  return /\s/u.test(value) ? JSON.stringify(value) : value;
}
