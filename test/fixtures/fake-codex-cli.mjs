// Fake `codex exec <task> --json` for tests. Never spawns the real CLI — see
// CliAgentDriver.test.ts. Behavior is chosen by a sentinel substring anywhere
// in argv, independent of exact flag position.
const argv = process.argv.slice(2).join(' ');

function line(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

if (argv.includes('TRIGGER_SLOW')) {
  setInterval(() => {}, 1000);
} else if (argv.includes('TRIGGER_FAIL')) {
  process.stderr.write('codex: boom, something broke\n');
  process.exitCode = 1;
} else if (argv.includes('TRIGGER_ERROR_RESULT')) {
  line({ id: '0', msg: { type: 'error', message: 'sandbox denied the requested command' } });
} else {
  line({ id: '0', msg: { type: 'task_started' } });
  line({ id: '0', msg: { type: 'agent_message_delta', delta: 'Looking at the repo. ' } });
  line({ id: '0', msg: { type: 'exec_command_begin', command: ['ls', 'src'] } });
  line({ id: '0', msg: { type: 'exec_command_end', exit_code: 0 } });
  line({ id: '0', msg: { type: 'patch_apply_begin', changes: { 'src/foo.ts': {} } } });
  line({ id: '0', msg: { type: 'task_complete', last_agent_message: 'Done: updated src/foo.ts' } });
}
