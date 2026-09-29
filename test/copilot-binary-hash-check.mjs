// Decisive test: is the on-disk copilot.exe the 1.0.88 or the 1.0.89 binary?
// Downloads both platform tarballs from the npm registry, extracts copilot.exe
// from each, and compares SHA-256 against the local file.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCAL = 'C:/Users/efso office/AppData/Roaming/npm/node_modules/@github/copilot/node_modules/@github/copilot-win32-x64/copilot.exe';

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-hash-'));
console.log('tmp dir:', tmp);

const localHash = sha256(LOCAL);
console.log('LOCAL  copilot.exe sha256:', localHash);
console.log('LOCAL  size:', fs.statSync(LOCAL).size);

for (const ver of ['1.0.88', '1.0.89']) {
  const url = `https://registry.npmjs.org/@github/copilot-win32-x64/-/copilot-win32-x64-${ver}.tgz`;
  const tgz = path.join(tmp, `cp-${ver}.tgz`);
  try {
    fs.writeFileSync(tgz, Buffer.from(await (await fetch(url)).arrayBuffer()));
  } catch (err) {
    console.log(`\n${ver}: download failed: ${err.message}`);
    continue;
  }
  const dir = path.join(tmp, `cp-${ver}`);
  fs.mkdirSync(dir);
  try {
    // tar -xzf works on Windows 10+ (bsdtar)
    execFileSync('tar', ['-xzf', tgz, '-C', dir], { timeout: 120000 });
  } catch (err) {
    console.log(`\n${ver}: extract failed: ${err.message}`);
    continue;
  }
  const exe = path.join(dir, 'package', 'copilot.exe');
  if (!fs.existsSync(exe)) {
    console.log(`\n${ver}: copilot.exe not in tarball; contents:`, fs.readdirSync(path.join(dir, 'package')).join(', '));
    continue;
  }
  const h = sha256(exe);
  const size = fs.statSync(exe).size;
  console.log(`\n${ver} tarball copilot.exe sha256:`, h);
  console.log(`${ver} tarball size:`, size);
  console.log(`${ver} MATCHES LOCAL:`, h === localHash);
}

fs.rmSync(tmp, { recursive: true, force: true });
