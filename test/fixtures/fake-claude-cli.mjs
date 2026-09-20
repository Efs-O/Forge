// Fake `claude` CLI for tests. Never spawns the real CLI.
//
// Two modes, chosen by the `--input-format` flag (mirrors the real CLI):
//   - **One-shot** (no `--input-format`): `claude -p <task> --output-format
//     stream-json --verbose`. Behavior is chosen by a sentinel substring in
//     argv (the task text), independent of exact flag position — the
//     `CliAgentDriver` / `CliAgentSession` (one-shot) tests.
//   - **Streaming input** (`--input-format stream-json`): a persistent session
//     that stays alive across turns, speaking the streaming-input protocol
//     over stdio — the `ClaudeOwnedSession` (P4) tests.
import readline from 'node:readline';

const argv = process.argv.slice(2).join(' ');

function line(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function resumedId() {
  const i = process.argv.indexOf('--resume');
  return i !== -1 ? process.argv[i + 1] : 'fixture-session-id';
}

function emitTask(task, turn = 1) {
  if (task.includes('TRIGGER_INIT_THEN_SLOW')) {
    // Announce the session id (as the real CLI does, immediately) and then
    // stall, so the caller's timeout fires on a turn whose id is already known.
    line({ type: 'system', subtype: 'init', session_id: resumedId() });
    return;
  }
  if (task.includes('TRIGGER_ECHO_ENTRYPOINT')) {
    line({ type: 'result', is_error: false, result: `entrypoint=${process.env.CLAUDE_CODE_ENTRYPOINT ?? ''}` });
    return;
  }
  if (task.includes('TRIGGER_SLOW')) return;
  if (task.includes('TRIGGER_FAIL')) {
    process.stderr.write('claude: boom, something broke\n');
    process.exitCode = 1;
    return;
  }
  if (task.includes('TRIGGER_ERROR_RESULT')) {
    line({ type: 'result', subtype: 'error', is_error: true, result: 'refused: unsafe request' });
    return;
  }
  const sessionId = resumedId();
  line({ type: 'system', subtype: 'init', session_id: sessionId });
  line({
    type: 'assistant',
    session_id: sessionId,
    message: { content: [{ type: 'text', text: `Looking at turn ${turn}. ` }] },
  });
  line({
    type: 'assistant',
    session_id: sessionId,
    message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/foo.ts' } }] },
  });
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } });
  line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    result: task.includes('WARM_TURN') ? `Done warm turn ${turn}` : 'Done: updated src/foo.ts',
  });
}

if (process.argv.includes('--input-format')) {
  // Streaming input: a persistent session. The init message (with the session
  // id) is emitted at startup; each user message gets an assistant/result
  // sequence, and the process stays alive across turns.
  const sessionId = resumedId();
  let turn = 0;
  line({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fixture' });

  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // not a protocol frame
    }
    if (msg.type !== 'user') return;
    const content = msg.message?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('')
          : '';
    turn += 1;

    if (text.includes('TRIGGER_PROTOCOL')) {
      // A line that is not a JSON frame: the owned session must fail the turn.
      process.stdout.write('{broken json\n');
      return;
    }
    if (text.includes('TRIGGER_ECHO_ENTRYPOINT')) {
      line({ type: 'result', is_error: false, result: `entrypoint=${process.env.CLAUDE_CODE_ENTRYPOINT ?? ''}` });
      return;
    }
    if (text.includes('TRIGGER_INIT_THEN_SLOW')) {
      // Re-announce the id and stall, so a caller timeout fires on a known id.
      line({ type: 'system', subtype: 'init', session_id: sessionId });
      return;
    }
    if (text.includes('TRIGGER_SLOW')) return; // hold the turn open (no result)
    if (text.includes('TRIGGER_FAIL')) {
      process.stderr.write('claude: boom, something broke\n');
      process.exitCode = 1;
      return;
    }
    if (text.includes('TRIGGER_ERROR_RESULT')) {
      line({ type: 'result', subtype: 'error', is_error: true, result: 'refused: unsafe request' });
      return;
    }

    line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `Looking at turn ${turn}. ` }] },
    });
    line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/foo.ts' } }] },
    });
    line({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: sessionId,
      result: text.includes('WARM_TURN') ? `Done warm turn ${turn}` : `Done claude turn ${turn} finished.`,
    });
  });
} else if (argv.includes('TRIGGER_SLOW')) {
  // Keep the process alive; the driver's own timeout/cancellation must kill it.
  setInterval(() => {}, 1000);
} else if (argv.includes('TRIGGER_FAIL')) {
  process.stderr.write('claude: boom, something broke\n');
  process.exitCode = 1;
} else if (argv.includes('TRIGGER_ERROR_RESULT')) {
  line({ type: 'result', subtype: 'error', is_error: true, result: 'refused: unsafe request' });
} else {
  line({ type: 'system', subtype: 'init' });
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the repo. ' }] } });
  line({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/foo.ts' } }] },
  });
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } });
  line({ type: 'result', subtype: 'success', is_error: false, result: 'Done: updated src/foo.ts' });
}
