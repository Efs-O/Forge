// Fake `codex exec <task> --json` for tests. Never spawns the real CLI — see
// CliAgentDriver.test.ts. Behavior is chosen by a sentinel substring anywhere
// in argv, independent of exact flag position.
import readline from 'node:readline';

const argv = process.argv.slice(2).join(' ');

function line(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

if (process.argv.includes('app-server')) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const hasForgeFullAccessOverride = process.argv.includes('sandbox_mode="danger-full-access"');
  let threadId = 'fixture-thread-id';
  let turn = 0;
  let activeTurn;
  let historyOnlyFinalMessage;
  input.on('line', (raw) => {
    const message = JSON.parse(raw);
    if (message.method === 'initialized') return;
    if (message.method === 'initialize') {
      line({ id: message.id, result: { userAgent: 'fake-codex' } });
      return;
    }
    if (message.method === 'thread/start') {
      if (
        process.argv.includes('REQUIRE_FORGE_FULL_ACCESS') &&
        !hasForgeFullAccessOverride
      ) {
        line({ id: message.id, error: { message: 'missing Forge full-access override' } });
        return;
      }
      line({ id: message.id, result: { thread: { id: threadId } } });
      return;
    }
    if (message.method === 'thread/resume') {
      threadId = message.params.threadId;
      line({ id: message.id, result: { thread: { id: threadId } } });
      return;
    }
    if (message.method === 'thread/read') {
      line({
        id: message.id,
        result: {
          thread: {
            turns: [
              {
                id: activeTurn,
                items: historyOnlyFinalMessage
                  ? [
                      {
                        type: 'agentMessage',
                        id: `history-message-${turn}`,
                        text: historyOnlyFinalMessage,
                      },
                    ]
                  : [],
              },
            ],
          },
        },
      });
      return;
    }
    if (message.method === 'turn/start') {
      turn += 1;
      activeTurn = `turn-${turn}`;
      const text = message.params.input[0].text;
      historyOnlyFinalMessage = text.includes('TRIGGER_HISTORY_ONLY_MESSAGE')
        ? ' The command completed successfully from history.'
        : undefined;
      line({ id: message.id, result: { turn: { id: activeTurn } } });
      line({
        method: 'turn/started',
        params: { threadId, turn: { id: activeTurn, status: 'inProgress' } },
      });
      if (text.includes('TRIGGER_PROTOCOL')) {
        process.stdout.write('{broken json\n');
        return;
      }
      if (text.includes('TRIGGER_SLOW')) return;
      line({
        method: 'item/started',
        params: { threadId, turnId: activeTurn, item: { type: 'commandExecution' } },
      });
      line({
        method: 'item/agentMessage/delta',
        params: {
          threadId,
          turnId: activeTurn,
          itemId: text.includes('TRIGGER_MISMATCHED_DELTA_ITEM')
            ? `streamed-message-${turn}`
            : `message-${turn}`,
          delta: `Done codex turn ${turn}`,
        },
      });
      if (text.includes('TRIGGER_MISMATCHED_DELTA_ITEM')) {
        line({
          method: 'item/completed',
          params: {
            threadId,
            turnId: activeTurn,
            item: {
              type: 'agentMessage',
              id: `completed-message-${turn}`,
              text: `Done codex turn ${turn}`,
            },
          },
        });
      }
      if (text.includes('TRIGGER_COMPLETED_MESSAGE')) {
        line({
          method: 'item/completed',
          params: {
            threadId,
            turnId: activeTurn,
            item: {
              type: 'agentMessage',
              id: `final-message-${turn}`,
              text: ' The command completed successfully.',
            },
          },
        });
      }
      line({
        method: 'turn/completed',
        params: { threadId, turn: { id: activeTurn, status: 'completed' } },
      });
      return;
    }
    if (message.method === 'turn/interrupt') {
      line({ id: message.id, result: {} });
      line({
        method: 'turn/completed',
        params: { threadId, turn: { id: activeTurn, status: 'interrupted' } },
      });
    }
  });
} else if (argv.includes('TRIGGER_SLOW')) {
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
