// Inventory every Copilot CLI on this machine: launcher contents, binary path,
// version, and mtime. Read-only.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const bundledDir = 'C:/Users/efso office/AppData/Roaming/Code/User/globalStorage/github.copilot-chat/copilotCli';
const npmDir = 'C:/Users/efso office/AppData/Roaming/npm/node_modules/@github/copilot/node_modules/@github/copilot-win32-x64';

console.log('--- bundled launcher (copilot, 126 bytes) ---');
console.log(fs.readFileSync(bundledDir + '/copilot', 'utf8'));

console.log('--- bundled copilot.ps1 (exe paths + version refs) ---');
const ps1 = fs.readFileSync(bundledDir + '/copilot.ps1', 'utf8');
const exePaths = [...new Set(ps1.match(/[A-Za-z]:\\[^\s"'`]+\.exe/g) ?? [])];
console.log(exePaths.join('\n') || '(no exe path found)');
const verLine = ps1.split(/\r?\n/).find((l) => /version/i.test(l));
console.log('version line:', verLine ?? '(none)');

// Find the bundled binary next to the shims (common layout: copilot.exe or a bin/ dir)
function listDir(d) {
  try {
    return fs.readdirSync(d, { withFileTypes: true }).map((e) => e.name);
  } catch {
    return ['(missing: ' + d + ')'];
  }
}
console.log('\n--- bundled dir contents ---');
console.log(listDir(bundledDir).join('\n'));

// If a binary path was found, report its version + mtime
for (const p of exePaths) {
  const norm = p.replace(/\\/g, '/');
  try {
    const st = fs.statSync(norm);
    console.log('\nbinary mtime:', norm, st.mtime.toISOString());
    try {
      const out = execFileSync(norm, ['--version'], { timeout: 15000, encoding: 'utf8' });
      console.log('binary version:', out.trim());
    } catch (err) {
      console.log('version probe failed:', err.message);
    }
  } catch (err) {
    console.log('stat failed for', norm, ':', err.message);
  }
}

console.log('\n--- npm platform binary ---');
const npmExe = npmDir + '/copilot.exe';
console.log('mtime:', fs.statSync(npmExe).mtime.toISOString());
console.log('version:', execFileSync(npmExe, ['--version'], { timeout: 15000, encoding: 'utf8' }).trim());
