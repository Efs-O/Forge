// Diagnostic driver for the job keeper: shows the Win32 answer for a real
// assign and whether the grandchild dies when the job is closed.
import { spawn } from 'child_process';

const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const sleepSeconds = 40;

function sleepers() {
  const out = [];
  const ps = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter "Name='sleep.exe'" | Where-Object { $_.CommandLine -like '* ${sleepSeconds}' } | ForEach-Object { "{0} ppid={1}" -f $_.ProcessId, $_.ParentProcessId }`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return new Promise((resolve) => {
    ps.stdout.on('data', (chunk) => out.push(chunk.toString()));
    ps.on('close', () =>
      resolve(
        out
          .join('')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    );
  });
}

const keeper = spawn(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/lab-sync/keeper-probe.ps1'],
  { stdio: ['pipe', 'pipe', 'pipe'] },
);
keeper.stdout.on('data', (chunk) => process.stdout.write(`keeper| ${chunk}`));
keeper.stderr.on('data', (chunk) => process.stdout.write(`keeper-err| ${chunk}`));

await new Promise((resolve) => setTimeout(resolve, 1500));

const child = spawn(bash, ['--noprofile', '--norc', '-c', `sleep ${sleepSeconds} && echo late`], {
  stdio: 'ignore',
  windowsHide: true,
});
console.log(`bash pid=${child.pid}`);
keeper.stdin.write(`job t1 ${child.pid}\n`);

// Control: is this about bash specifically, or about anything this node spawns?
const plain = spawn('ping.exe', ['-n', '30', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
console.log(`ping pid=${plain.pid}`);
keeper.stdin.write(`job t2 ${plain.pid}\n`);
await new Promise((resolve) => setTimeout(resolve, 300));
keeper.stdin.write('kill t2\n');
try {
  plain.kill();
} catch {
  /* gone */
}

await new Promise((resolve) => setTimeout(resolve, 600));
console.log(`after assign: ${JSON.stringify(await sleepers())}`);

keeper.stdin.write('kill t1\n');
await new Promise((resolve) => setTimeout(resolve, 1000));
const left = await sleepers();
console.log(`after kill: ${JSON.stringify(left)}`);
for (const line of left) {
  spawn('taskkill', ['/PID', line.split(' ')[0], '/F'], { stdio: 'ignore' });
}
keeper.stdin.write('quit\n');
await new Promise((resolve) => setTimeout(resolve, 500));
keeper.kill();
