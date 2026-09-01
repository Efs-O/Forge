import type { CliAdapter } from '../types';

/**
 * Parses `codex exec <task> --json` JSONL protocol events (codex-rs
 * `msg.type`): agent_message_delta (text), exec_command_begin (status),
 * patch_apply_begin (status), task_complete (final), error.
 */
export const codexAdapter: CliAdapter = {
  name: 'codex',
  buildArgs(task, options) {
    // `--skip-git-repo-check`: codex exec refuses to start outside a trusted git
    // repository, which fails every delegation in a non-git workspace regardless
    // of sandbox level. That check is an interactive-CLI guardrail; blast radius
    // here is governed by --sandbox, which we always pass.
    const args = options?.sessionId
      ? ['exec', 'resume', options.sessionId, task, '--json', '--skip-git-repo-check']
      : ['exec', task, '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access'];
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
      return; // non-JSON noise — ignore rather than fail the run
    }
    if (!event || typeof event !== 'object') return;
    const obj = event as Record<string, unknown>;

    // Current codex exec JSONL protocol (0.144.x): lifecycle events are
    // top-level and useful payloads live under `item`.
    const eventType = obj['type'];
    if (eventType === 'thread.started' && typeof obj['thread_id'] === 'string') {
      ctx.setSessionId(obj['thread_id']);
      return;
    }
    const itemField = obj['item'];
    const item =
      itemField && typeof itemField === 'object'
        ? (itemField as Record<string, unknown>)
        : undefined;
    if (eventType === 'item.started' && item?.['type'] === 'command_execution') {
      ctx.emitStatus(`[codex: exec ${String(item['command'] ?? '')}]`);
      return;
    }
    if (eventType === 'item.completed' && item?.['type'] === 'file_change') {
      const changes = item['changes'];
      const paths = Array.isArray(changes)
        ? changes.flatMap((change) => {
            if (!change || typeof change !== 'object') return [];
            const path = (change as Record<string, unknown>)['path'];
            return typeof path === 'string' ? [path] : [];
          })
        : [];
      ctx.emitStatus(`[codex: edit ${paths.join(', ') || '?'}]`);
      return;
    }
    if (eventType === 'item.completed' && item?.['type'] === 'agent_message') {
      const text = typeof item['text'] === 'string' ? item['text'] : '';
      if (text) ctx.emitText(text);
      ctx.setFinal(text);
      return;
    }
    if (eventType === 'turn.failed') {
      const failure = obj['error'];
      const message =
        failure && typeof failure === 'object'
          ? (failure as Record<string, unknown>)['message']
          : undefined;
      ctx.setError(typeof message === 'string' ? message : 'codex CLI turn failed.');
      return;
    }

    // Legacy codex-rs JSONL protocol retained for older installed CLIs.
    const msgField = obj['msg'];
    const msg = (msgField && typeof msgField === 'object' ? msgField : obj) as Record<
      string,
      unknown
    >;
    const type = msg['type'];

    if (type === 'agent_message_delta' && typeof msg['delta'] === 'string') {
      ctx.emitText(msg['delta']);
      return;
    }
    if (type === 'exec_command_begin') {
      const command = msg['command'];
      const label = Array.isArray(command) ? command.join(' ') : String(command ?? '');
      ctx.emitStatus(`[codex: exec ${label}]`);
      return;
    }
    if (type === 'patch_apply_begin') {
      const changes = msg['changes'];
      const files = changes && typeof changes === 'object' ? Object.keys(changes as object) : [];
      ctx.emitStatus(`[codex: edit ${files.join(', ') || '?'}]`);
      return;
    }
    if (type === 'task_complete') {
      ctx.setFinal(typeof msg['last_agent_message'] === 'string' ? msg['last_agent_message'] : '');
      return;
    }
    if (type === 'error') {
      ctx.setError(
        typeof msg['message'] === 'string' ? msg['message'] : 'codex CLI reported an error.',
      );
    }
  },
};
