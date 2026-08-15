// Fake `claude -p <task> --output-format stream-json --verbose` for tests.
// Never spawns the real CLI — see CliAgentDriver.test.ts. Behavior is chosen
// by a sentinel substring anywhere in argv (the task text), independent of
// exact flag position, mirroring test/fixtures/fake-rg.mjs's query-driven pattern.
import readline from 'node:readline';

const argv = process.argv.slice(2).join(' ');

function line(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function emitTask(task, turn = 1) {
  if (task.includes('TRIGGER_INIT_THEN_SLOW')) {
    // Announce the session id (as the real CLI does, immediately) and then
    // stall, so the caller's timeout fires on a turn whose id is already known.
    const resumed = process.argv.includes('--resume')
      ? process.argv[process.argv.indexOf('--resume') + 1]
      : 'fixture-session-id';
    line({ type: 'system', subtype: 'init', session_id: resumed });
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
  const sessionId = process.argv.includes('--resume')
    ? process.argv[process.argv.indexOf('--resume') + 1]
    : 'fixture-session-id';
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
  let turn = 0;
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (value) => {
    const message = JSON.parse(value);
    const text = message?.message?.content?.[0]?.text ?? '';
    turn += 1;
    emitTask(text, turn);
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
