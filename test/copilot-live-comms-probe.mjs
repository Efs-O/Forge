// Live probe: full ACP comms against the real (updated) Copilot CLI, using
// the exact wire shape the fixed CopilotAcpSession sends (jsonrpc 2.0 on
// every frame). Steps: initialize -> session/load (stored Forge-owned
// session) -> session/prompt (one-word task). Reports each step.
import { spawn } from 'node:child_process';

const EXECUTABLE = 'copilot.cmd';
const CWD = process.cwd();
const STORED_SESSION_ID = '27d658f0-22e4-423d-8d8d-f9eade4f938e';

const child = spawn(EXECUTABLE, ['--acp', '--stdio', '--no-remote', '--allow-all'], {
  cwd: CWD,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true,
});

let nextId = 1;
const pending = new Map();
let replayUpdates = 0;
let promptText = '';
let stderrTail = '';

const rl = await import('node:readline').then((m) => m.createInterface({ input: child.stdout }));

rl.on('line', (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof msg.id === 'number' && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
    return;
  }
  if (msg.method === 'session/update') {
    const update = msg.params?.update;
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      promptText += update.content.text;
    } else {
      replayUpdates += 1;
    }
  }
});

child.stderr.on('data', (d) => {
  stderrTail = (stderrTail + d.toString()).slice(-2000);
});

function request(method, params, timeoutMs) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms waiting for ${method} response`));
      }
    }, timeoutMs);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return promise;
}

const report = {};
try {
  // Wait for the ACP server to come up (it logs "ACP server started" ~2-3s in).
  await new Promise((r) => setTimeout(r, 3500));

  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 20000);
  report.initialize = init;

  let load;
  try {
    load = await request(
      'session/load',
      { sessionId: STORED_SESSION_ID, cwd: CWD, mcpServers: [] },
      30000,
    );
  } catch (err) {
    load = { error: String(err) };
  }
  report.load = load;
  report.replayUpdates = replayUpdates;

  if (load.error || load.result === undefined) {
    report.note = 'session/load failed or errored; stopping before prompt.';
  } else {
    const prompt = await request(
      'session/prompt',
      {
        sessionId: STORED_SESSION_ID,
        prompt: [{ type: 'text', text: 'Reply with exactly one word: pong' }],
      },
      120000,
    );
    report.prompt = prompt;
    report.promptText = promptText;
  }
} catch (err) {
  report.fatal = String(err);
} finally {
  child.stdin.end();
  setTimeout(() => child.kill(), 2000).unref();
}

console.log(JSON.stringify(report, null, 2));
if (stderrTail) console.log('\n--- stderr tail ---\n' + stderrTail);
