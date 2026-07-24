// Fake `claude -p <task> --output-format stream-json --verbose` for tests.
// Never spawns the real CLI — see CliAgentDriver.test.ts. Behavior is chosen
// by a sentinel substring anywhere in argv (the task text), independent of
// exact flag position, mirroring test/fixtures/fake-rg.mjs's query-driven pattern.
const argv = process.argv.slice(2).join(' ');

function line(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

if (argv.includes('TRIGGER_SLOW')) {
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
