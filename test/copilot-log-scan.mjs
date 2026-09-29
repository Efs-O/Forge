// Grep the Forge extension logs in the P4 window and the current window for
// copilot/ACP lines, with context.
import fs from 'node:fs';
import path from 'node:path';

const base = 'C:/Users/efso office/AppData/Roaming/Code/logs';

function findForgeLogs(folder) {
  const root = path.join(base, folder);
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const w of fs.readdirSync(root, { withFileTypes: true })) {
    if (!w.isDirectory() || !/^window\d+$/.test(w.name)) continue;
    const exthost = path.join(root, w.name, 'exthost');
    if (!fs.existsSync(exthost)) continue;
    for (const e of fs.readdirSync(exthost, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith('output_logging')) continue;
      for (const f of fs.readdirSync(path.join(exthost, e.name))) {
        if (/forge/i.test(f)) out.push(path.join(exthost, e.name, f));
      }
    }
  }
  return out;
}

function scan(folder, label) {
  console.log(`\n========== ${label} (${folder}) ==========`);
  const logs = findForgeLogs(folder);
  if (!logs.length) { console.log('(no Forge logs found)'); return; }
  for (const log of logs) {
    const content = fs.readFileSync(log, 'utf8');
    const lines = content.split(/\r?\n/);
    let hits = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/copilot|acp/i.test(l) && !/CheckpointStack|snapshotted/i.test(l)) {
        console.log(`\n--- ${path.basename(log)}:${i + 1} ---`);
        // print this line + up to 2 following lines for context
        for (let j = i; j < Math.min(i + 3, lines.length); j++) {
          console.log(lines[j].trim().slice(0, 400));
        }
        hits++;
        if (hits > 40) { console.log('...(truncated)'); return; }
      }
    }
    if (hits === 0) console.log(`${path.basename(log)}: (no copilot/acp lines)`);
  }
}

scan('20260928T013228', 'P4 window');
scan('20260923T151135', 'current window');
