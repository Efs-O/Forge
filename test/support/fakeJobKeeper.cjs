// Keeper stand-in for the Windows job keeper, so the line protocol is testable
// on Linux and macOS where GitHub CI runs: it records every command line it is
// given and never touches Win32. Set FORGE_JOB_KEEPER_CMD to this file and
// FORGE_JOB_KEEPER_LOG to the file to append each line to.
const fs = require('fs');
const readline = require('readline');

const log = process.env.FORGE_JOB_KEEPER_LOG;
readline
  .createInterface({ input: process.stdin })
  .on('line', (line) => {
    if (log) fs.appendFileSync(log, `${line}\n`);
  });
