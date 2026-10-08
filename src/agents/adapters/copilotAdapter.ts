import type { CliAdapter } from '../types';

/** One-shot Copilot CLI adapter used to create or resume a linked session. */
export const copilotAdapter: CliAdapter = {
  name: 'copilot',
  buildArgs(task, options) {
    const args = ['-p', task, '--silent', '--no-remote', '--disable-builtin-mcps', '--allow-all'];
    if (options?.sessionId) args.push('--resume', options.sessionId);
    else if (options?.createSessionId) args.push('--session-id', options.createSessionId);
    if (!options?.sessionId && options?.sessionTitle) args.push('-n', options.sessionTitle);
    if (options?.model === undefined) throw new Error('Copilot CLI model must be configured.');
    args.push('--model', options.model);
    return args;
  },
  handleLine(line, context) {
    const text = line.trimEnd();
    if (!text) return;
    context.emitText(`${text}\n`);
    context.appendFinal(text);
  },
};
