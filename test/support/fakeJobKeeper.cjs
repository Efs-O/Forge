// Keeper stand-in for the Windows job keeper, so the line protocol is testable
// on Linux and macOS where GitHub CI runs: it records every command line it is
// given and never touches Win32. Set FORGE_JOB_KEEPER_CMD to this file and
// FORGE_JOB_KEEPER_LOG to the file to append each line to.
const fs = require('fs');
const readline = require('readline');

const log = process.env.FORGE_JOB_KEEPER_LOG;
// The real keeper prints `ready` once it can create a job, and
// warmWindowsJobKeeper waits for exactly that line, so the fake behaves the same.
// FORGE_JOB_KEEPER_READY_DELAY_MS moves that line later, which is how a test
// gets a keeper that outlives its own retirement and writes after being
// replaced — the one line the caller must ignore.
const readyDelay = Number(process.env.FORGE_JOB_KEEPER_READY_DELAY_MS);
if (Number.isFinite(readyDelay) && readyDelay > 0) {
  setTimeout(() => process.stdout.write('ready\n'), readyDelay);
} else {
  process.stdout.write('ready\n');
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (log) fs.appendFileSync(log, `${line}\n`);
});
// A closed stdin means the module is finished with this keeper: leave, but give
// a delayed `ready` above one second to land first, so the late line the caller
// has to ignore really arrives, and no retired keeper outlives its test.
rl.on('close', () => setTimeout(() => process.exit(0), 1_000));
