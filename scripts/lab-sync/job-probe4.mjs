// Which handle rights does AssignProcessToJobObject actually need here?
import { spawn } from 'child_process';

const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const sleepSeconds = 43;

function ps(script) {
  const out = [];
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return new Promise((resolve) => {
    child.stdout.on('data', (chunk) => out.push(chunk.toString()));
    child.on('close', () =>
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

const childrenOf = (pid) =>
  ps(
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "{0} {1}" -f $_.ProcessId, $_.Name }`,
  );

const keeper = spawn(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/lab-sync/keeper-probe.ps1'],
  { stdio: ['pipe', 'pipe', 'pipe'] },
);
keeper.stdout.on('data', (chunk) => process.stdout.write(`keeper| ${chunk}`));
keeper.stderr.on('data', (chunk) => process.stdout.write(`keeper-err| ${chunk}`));
keeper.stdin.write('self\n');
await new Promise((resolve) => setTimeout(resolve, 2000));

const root = spawn(bash, ['--noprofile', '--norc', '-c', `sleep ${sleepSeconds} && echo late`], {
  stdio: 'ignore',
  windowsHide: true,
});
console.log(`launcher bash pid=${root.pid}`);
await new Promise((resolve) => setTimeout(resolve, 500));
const kids = await childrenOf(root.pid);
console.log(`children: ${JSON.stringify(kids)}`);
const realPid = Number(
  (kids.find((line) => /bash\.exe$/i.test(line)) ?? '0 0').split(' ')[0],
);

for (const mask of ['110', '400', '1000', '1FFFFF', '1F0FFF']) {
  keeper.stdin.write(`try m${mask} ${realPid} ${mask}\n`);
  await new Promise((resolve) => setTimeout(resolve, 120));
}
for (const mask of ['110', '1FFFFF']) {
  keeper.stdin.write(`try r${mask} ${root.pid} ${mask}\n`);
  await new Promise((resolve) => setTimeout(resolve, 120));
}
// And a process the keeper itself started, so the handle comes from the same process.
keeper.stdin.write('own\n');
await new Promise((resolve) => setTimeout(resolve, 800));
keeper.stdin.write('quit\n');
await new Promise((resolve) => setTimeout(resolve, 300));
keeper.kill();
try {
  spawn('taskkill', ['/PID', String(root.pid), '/T', '/F'], { stdio: 'ignore' });
} catch {
  /* gone */
}
