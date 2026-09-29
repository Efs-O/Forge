// Probe: does the Copilot CLI ACP require "jsonrpc":"2.0" in outgoing messages?
// Sends initialize WITHOUT jsonrpc, then WITH, and reports the responses.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const EXECUTABLE = 'copilot.cmd';
const CWD = process.cwd();

function probe(label, withJsonrpc) {
  return new Promise((resolve) => {
    const child = spawn(EXECUTABLE, ['--acp', '--stdio', '--no-remote', '--allow-all'], {
      cwd: CWD,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });
    const rl = createInterface({ input: child.stdout });
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      rl.close();
      child.kill();
      resolve(result);
    };

    const timer = setTimeout(() => finish({ label, error: 'timeout (10s)' }), 10000);

    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          clearTimeout(timer);
          finish({ label, response: msg });
        }
      } catch { /* ignore non-JSON lines */ }
    });

    child.stderr.on('data', (d) => {
      // Capture stderr for diagnostics but don't fail on it
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ label, error: `spawn: ${err.message}` });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      finish({ label, error: `exited with code ${code} before response` });
    });

    // Give the child a moment to start, then send initialize
    setTimeout(() => {
      const msg = withJsonrpc
        ? { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }
        : { id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } };
      child.stdin.write(JSON.stringify(msg) + '\n');
    }, 1500);
  });
}

console.log('=== Copilot ACP probe ===\n');

const r1 = await probe('WITHOUT jsonrpc', false);
console.log('WITHOUT jsonrpc:', JSON.stringify(r1, null, 2), '\n');

const r2 = await probe('WITH jsonrpc', true);
console.log('WITH jsonrpc:', JSON.stringify(r2, null, 2), '\n');
