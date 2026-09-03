// Build a deterministic stratified 50-task sample from the 500 SWE-bench
// Verified instances.
//   - 50 seats allocated proportionally to each repo's share of the 500
//     (largest-remainder rounding, deterministic).
//   - The 5 tasks already benchmarked are guaranteed to be in the sample;
//     if a locked task's repo allocation is too small, same-repo fill-ins are
//     added (so every arm still shares one fixed 50, and prior results count).
// Read:  results/swe-bench-verified-500.json
// Write: results/swe-bench-verified-50.json
import fs from 'node:fs';

const N = 50;
const { instances } = JSON.parse(
  fs.readFileSync('results/swe-bench-verified-500.json', 'utf8'),
);

const LOCKED = [
  'astropy__astropy-12907',
  'django__django-10097',
  'matplotlib__matplotlib-13989',
  'scikit-learn__scikit-learn-10297',
  'sympy__sympy-11618',
];

const byRepo = {};
for (const x of instances) (byRepo[x.repo] ??= []).push(x.instance_id);
for (const repo of Object.keys(byRepo)) byRepo[repo].sort();
const total = instances.length;
const repoOf = (id) => instances.find((x) => x.instance_id === id).repo;

// 1) exact proportional seats, largest-remainder to N
const exact = {};
for (const repo of Object.keys(byRepo)) exact[repo] = (byRepo[repo].length / total) * N;
const alloc = {};
let allocated = 0;
for (const repo of Object.keys(byRepo)) {
  alloc[repo] = Math.floor(exact[repo]);
  allocated += Math.floor(exact[repo]);
}
const byFrac = Object.keys(byRepo).sort(
  (a, b) => exact[b] - Math.floor(exact[b]) - (exact[a] - Math.floor(exact[a])) || a.localeCompare(b),
);
for (const repo of byFrac) {
  if (allocated >= N) break;
  alloc[repo] += 1;
  allocated += 1;
}

// 2) pick first alloc[repo] (sorted) from each repo
const picked = new Map(); // instance_id -> repo
for (const repo of Object.keys(alloc)) {
  for (const id of byRepo[repo].slice(0, alloc[repo])) picked.set(id, repo);
}

// 3) guarantee the 5 locked are present; top up their repos if needed
for (const id of LOCKED) {
  if (picked.has(id)) continue;
  const repo = repoOf(id);
  picked.set(id, repo);
  // find a same-repo id already in the sample to drop, keeping repo count stable
  const toDrop = [...picked.entries()].find(([pid, pro]) => pro === repo && pid !== id);
  if (toDrop) picked.delete(toDrop[0]);
}

const list = [...picked.entries()].map(([instance_id, repo]) => ({ instance_id, repo }));
list.sort((a, b) => a.instance_id.localeCompare(b.instance_id));

const out = {
  name: 'SWE-bench Verified stratified-50 (5 locked + proportional)',
  count: list.length,
  locked: LOCKED,
  allocation: alloc,
  instances: list,
};
fs.writeFileSync('results/swe-bench-verified-50.json', JSON.stringify(out, null, 2));

console.log(`picked ${list.length} / ${N}`);
console.log('\nrepo allocation (of 50):');
for (const [repo, n] of Object.entries(alloc).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${repo}\t${n}`);
}
console.log('\nall instance_ids:');
for (const x of list) console.log('  ' + x.instance_id);
