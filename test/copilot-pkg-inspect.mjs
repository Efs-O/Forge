// Inspect the Copilot CLI's self-update pkg dir, exp-cache, and its own logs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const pkg = 'C:/Users/efso office/AppData/Local/copilot/pkg';
console.log('=== pkg dir tree (depth 3) ===');
function tree(d, depth = 0) {
  if (depth > 3) return;
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(d, e.name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    console.log('  '.repeat(depth) + (e.isDirectory() ? '[dir] ' : `[file] ${st.size}b `) + e.name + '  ' + st.mtime.toISOString());
    if (e.isDirectory()) tree(p, depth + 1);
  }
}
tree(pkg);

// Find any copilot.exe under pkg and check its version
console.log('\n=== copilot.exe under pkg ===');
function findExe(d, out = []) {
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) findExe(p, out);
    else if (/copilot.*\.exe$/i.test(e.name)) out.push(p);
  }
  return out;
}
for (const exe of findExe(pkg)) {
  console.log(exe, fs.statSync(exe).mtime.toISOString());
  try {
    console.log('  version:', execFileSync(exe, ['--version'], { timeout: 20000, encoding: 'utf8' }).trim().split('\n')[0]);
  } catch (err) {
    console.log('  version probe failed:', err.message.slice(0, 200));
  }
}

console.log('\n=== exp-cache.json (jsonrpc/protocol/strict flags) ===');
try {
  const exp = JSON.parse(fs.readFileSync('C:/Users/efso office/AppData/Local/copilot/exp-cache.json', 'utf8'));
  const s = JSON.stringify(exp);
  const keys = Object.keys(exp);
  console.log('top-level keys:', keys.join(', '));
  // print any entry mentioning jsonrpc, rpc, protocol, strict, acp, wire
  const interesting = s.split('"').filter((tok) => /jsonrpc|rpc|protocol|strict|acp|wire/i.test(tok));
  console.log('interesting tokens:', [...new Set(interesting)].slice(0, 40).join(' | ') || '(none)');
} catch (err) {
  console.log('exp-cache read failed:', err.message);
}

console.log('\n=== .copilot/logs (CLI own logs) ===');
const logs = 'C:/Users/efso office/.copilot/logs';
try {
  for (const e of fs.readdirSync(logs, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 10)) {
    const p = path.join(logs, e.name);
    const st = fs.statSync(p);
    console.log(`${e.isDirectory() ? '[dir] ' : '[file] '}${e.name}  ${st.mtime.toISOString()}  ${st.size}b`);
  }
} catch (err) {
  console.log('logs read failed:', err.message);
}
