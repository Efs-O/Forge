// Decisive test: a keeper launched through bash (which breaks its children out of
// VS Code's job) is itself outside any job, so the job it creates is top-level.
// Question: can that job then hold the real bash that the launcher spawns?
import { spawn } from 'child_process';

const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const sleepSeconds = 42;

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
const sleepers = () =>
  ps(
    `$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter "Name='sleep.exe'" | Where-Object { $_.CommandLine -like '* ${sleepSeconds}' } | ForEach-Object { "{0} ppid={1}" -f $_.ProcessId, $_.ParentProcessId }`,
  );

// The keeper, launched through bash so it lands outside the outer job.
const keeper = spawn(
  bash,
  [
    '--noprofile',
    '--norc',
    '-c',
    'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/lab-sync/keeper-probe.ps1',
  ],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
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
keeper.stdin.write(`job t0 ${root.pid}\n`);
await new Promise((resolve) => setTimeout(resolve, 500));
const kids = await childrenOf(root.pid);
console.log(`children of the launcher: ${JSON.stringify(kids)}`);
const realBash = kids.find((line) => /bash\.exe$/i.test(line));
if (!realBash) {
  console.log('no child bash to assign; aborting');
  keeper.kill();
  process.exit(1);
}
const realPid = Number(realBash.split(' ')[0]);
keeper.stdin.write(`job t1 ${realPid}\n`);
await new Promise((resolve) => setTimeout(resolve, 700));
console.log(`sleepers after assigning the child: ${JSON.stringify(await sleepers())}`);
keeper.stdin.write('kill t1\n');
await new Promise((resolve) => setTimeout(resolve, 1200));
const left = await sleepers();
console.log(`sleepers after kill: ${JSON.stringify(left)}`);
for (const line of left) spawn('taskkill', ['/PID', line.split(' ')[0], '/F'], { stdio: 'ignore' });
try {
  root.kill();
} catch {
  /* gone */
}
keeper.stdin.write('quit\n');
await new Promise((resolve) => setTimeout(resolve, 400));
keeper.kill();
