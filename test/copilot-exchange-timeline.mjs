// Find the P4 validation exchanges (ids recorded in the plan) and print
// their full state timelines with timestamps.
import fs from 'node:fs';

const p = 'C:/Users/efso office/.forge/agent-bus/exchanges.jsonl';
const lines = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/);
const rows = [];
for (const l of lines) {
  try { rows.push(JSON.parse(l)); } catch { /* skip */ }
}

const p4Ids = ['806ec064', '5c023099', '2bcdac40', '4b2486fc', 'bad7374e', '91ed96a3', 'f5d79584', '0ef61d0c'];
console.log('=== P4 validation exchanges (from plan) ===');
for (const id8 of p4Ids) {
  const matches = rows.filter((r) => (r.exchangeId || '').startsWith(id8));
  if (!matches.length) { console.log(id8, ': NOT FOUND'); continue; }
  const first = matches[0];
  console.log(`\n${id8}… (${first.from} -> ${first.to}):`);
  for (const r of matches) {
    console.log(`  ${new Date(r.ts).toISOString()}  ${r.type}  ${r.state ?? ''}`);
  }
}

console.log('\n=== ALL copilot exchanges, grouped, with times ===');
const cop = rows.filter((r) => JSON.stringify(r).includes('copilot'));
const byId = new Map();
for (const r of cop) {
  if (!byId.has(r.exchangeId)) byId.set(r.exchangeId, []);
  byId.get(r.exchangeId).push(r);
}
for (const [id, evs] of byId) {
  const t0 = new Date(evs[0].ts).toISOString();
  const states = evs.map((e) => e.state).filter(Boolean).join(' -> ');
  console.log(`${t0}  ${id.slice(0, 8)}  ${evs[0].from} -> ${evs[0].to}  [${states}]`);
}
