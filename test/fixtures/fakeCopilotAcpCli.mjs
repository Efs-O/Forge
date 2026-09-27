// Fake `copilot --acp --stdio` for tests. Never spawns the real CLI — see
// CopilotAcpSession.test.ts. Speaks the ACP v1 wire shape (newline-delimited
// JSON-RPC) over stdio. Behavior is chosen by sentinel substrings in argv
// (independent of exact flag position) and in the prompt text.
import readline from 'node:readline';

const argv = process.argv.slice(2).join(' ');

function line(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

if (process.argv.includes('TRIGGER_CRASH')) {
  process.exit(3);
}

if (process.argv.includes('--acp')) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let sessionId = 'fixture-copilot-session';
  let turn = 0;
  let promptId = 0;

  input.on('line', (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return; // not a protocol frame
    }
    if (message.method === 'initialize') {
      if (argv.includes('REQUIRE_PROTOCOL_VERSION') && message.params?.protocolVersion !== 1) {
        line({ id: message.id, error: { message: 'unsupported protocol version' } });
        return;
      }
      line({
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'Copilot', version: 'fixture' },
          agentCapabilities: {
            loadSession: argv.includes('NO_LOAD_SESSION') ? false : true,
            promptCapabilities: { image: false, embeddedContext: false },
            sessionCapabilities: { close: {}, list: {} },
          },
        },
      });
      return;
    }
    if (message.method === 'session/new') {
      if (argv.includes('NO_SESSION_ID')) {
        line({ id: message.id, result: {} });
        return;
      }
      line({ id: message.id, result: { sessionId } });
      return;
    }
    if (message.method === 'session/load') {
      if (argv.includes('LOAD_FAILS')) {
        line({ id: message.id, error: { message: 'session not found' } });
        return;
      }
      sessionId = message.params.sessionId;
      line({ id: message.id, result: { sessionId } });
      return;
    }
    if (message.method === 'session/prompt') {
      turn += 1;
      promptId = message.id;
      const text = (message.params?.prompt ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text.includes('TRIGGER_PROTOCOL')) {
        process.stdout.write('{broken json\n');
        return;
      }
      if (text.includes('TRIGGER_SLOW')) return; // hold the turn open (no response)
      if (text.includes('TRIGGER_ERROR_RESULT')) {
        line({ id: message.id, error: { message: 'quota exceeded' } });
        return;
      }
      if (text.includes('TRIGGER_OTHER_STOP')) {
        line({ id: message.id, result: { stopReason: 'max_tokens' } });
        return;
      }
      if (text.includes('TRIGGER_PERMISSION')) {
        // A server-initiated permission request the session must answer.
        line({
          id: 900,
          method: 'session/request_permission',
          params: { sessionId, toolCall: { name: 'shell' } },
        });
        return;
      }
      line({
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'thinking about it' },
          },
        },
      });
      line({
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'tool_call', toolCallName: 'shell', command: 'ls src' },
        },
      });
      line({
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Done copilot turn ${turn} ` },
          },
        },
      });
      line({
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'finished.' },
          },
        },
      });
      line({ id: message.id, result: { stopReason: 'end_turn' } });
      return;
    }
    if (message.method === 'session/cancel') {
      // ACP session/cancel is a JSON-RPC notification: no id, no response.
      // The terminal truth is the outstanding session/prompt settling with
      // stopReason: cancelled — when this fixture is configured to settle.
      if (argv.includes('CANCEL_NO_SETTLE')) return;
      line({ id: promptId, result: { stopReason: 'cancelled' } });
      return;
    }
  });
} else if (argv.includes('TRIGGER_SLOW')) {
  setInterval(() => {}, 1000);
}
