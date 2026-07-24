import type { CliAdapter } from '../types';

function summarizeToolInput(name: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    const target = record['file_path'] ?? record['path'] ?? record['command'];
    if (typeof target === 'string') return `${name} ${target}`;
  }
  return name;
}

/**
 * Parses `claude -p <task> --output-format stream-json --verbose` NDJSON:
 * - {"type":"assistant","message":{"content":[{"type":"text","text":...}]}}
 * - {"type":"assistant","message":{"content":[{"type":"tool_use","name":...,"input":...}]}}
 * - {"type":"result","is_error":bool,"result":"final text"}
 * `system`/`user` (tool_result) lines are intentionally ignored — Forge does
 * not run its own tool loop for this agent, it only relays progress.
 */
export const claudeAdapter: CliAdapter = {
  name: 'claude',
  buildArgs(task, access, options) {
    const args = [
      '-p',
      task,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      access === 'full' ? 'bypassPermissions' : access === 'write' ? 'acceptEdits' : 'plan',
    ];
    if (options?.sessionId) args.push('--resume', options.sessionId);
    if (options?.model) args.push('--model', options.model);
    return args;
  },
  handleLine(line, ctx) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return; // non-JSON noise (banners, warnings) — ignore rather than fail the run
    }
    if (!event || typeof event !== 'object') return;
    const obj = event as Record<string, unknown>;
    if (typeof obj['session_id'] === 'string') ctx.setSessionId(obj['session_id']);

    if (obj['type'] === 'assistant') {
      const message = obj['message'] as Record<string, unknown> | undefined;
      const content = message?.['content'];
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b['type'] === 'text' && typeof b['text'] === 'string') {
          ctx.emitText(b['text']);
        } else if (b['type'] === 'tool_use' && typeof b['name'] === 'string') {
          ctx.emitStatus(`[claude: ${summarizeToolInput(b['name'], b['input'])}]`);
        }
      }
      return;
    }

    if (obj['type'] === 'result') {
      const result = typeof obj['result'] === 'string' ? obj['result'] : '';
      if (obj['is_error'] === true) ctx.setError(result || 'claude CLI reported an error result.');
      else ctx.setFinal(result);
    }
  },
};
