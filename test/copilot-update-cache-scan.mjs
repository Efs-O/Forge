// Hunt for a Copilot CLI update cache: files/dirs modified today (2026-09-28)
// in the usual per-user state locations, especially between 19:46Z and 22:55Z.
import fs from 'node:fs';
import path from 'node:path';

const roots = [
  'C:/Users/efso office/AppData/Local/@github',
  'C:/Users/efso office/AppData/Local/copilot',
  'C:/Users/efso office/AppData/Roaming/@github',
  'C:/Users/efso office/AppData/Roaming/copilot',
  'C:/Users/efso office/.copilot',
  'C:/Users/efso office/.config/copilot',
];

const today = new Date('2026-09-28T00:00:00Z');

for (const root of roots) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { console.log(root, ': missing'); continue; }
  console.log(`\n=== ${root} ===`);
  for (const e of entries) {
    const p = path.join(root, e.name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    const mark = st.mtime >= today ? '  << TODAY' : '';
    console.log(`${e.isDirectory() ? '[dir] ' : '[file] '}${e.name}  mtime=${st.mtime.toISOString()}  size=${st.size}${mark}`);
  }
}

// Also: any copilot* entries in TEMP modified today
const tmp = 'C:/Users/efso office/AppData/Local/Temp';
console.log(`\n=== ${tmp} (copilot* only) ===`);
try {
  for (const e of fs.readdirSync(tmp, { withFileTypes: true })) {
    if (!/copilot|github/i.test(e.name)) continue;
    const p = path.join(tmp, e.name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    const mark = st.mtime >= today ? '  << TODAY' : '';
    console.log(`${e.isDirectory() ? '[dir] ' : '[file] '}${e.name}  mtime=${st.mtime.toISOString()}${mark}`);
  }
} catch (err) {
  console.log('temp scan failed:', err.message);
}
