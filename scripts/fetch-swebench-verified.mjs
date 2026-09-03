// Pull instance_id + repo for all 500 SWE-bench Verified tasks from the
// HuggingFace datasets-server API (paginated JSON), save to a local JSON file.
// No dependencies. Run: node scripts/fetch-swebench-verified.mjs
import fs from 'node:fs';

const DATASET = 'SWE-bench%2FSWE-bench_Verified';
const BASE = `https://datasets-server.huggingface.co/rows?dataset=${DATASET}&config=default&split=test`;
const PAGE = 100;

const all = [];
let offset = 0;
let total = null;

while (true) {
  const url = `${BASE}&offset=${offset}&length=${PAGE}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error('HTTP', res.status, url);
    const body = await res.text().catch(() => '');
    console.error(body.slice(0, 500));
    process.exit(1);
  }
  const j = await res.json();
  if (total === null) total = j.num_total_rows ?? j.total_rows ?? null;
  const rows = j.rows ?? [];
  for (const r of rows) {
    const row = r.row ?? r;
    const instance_id = row.instance_id;
    const repo = row.repo;
    if (instance_id) all.push({ instance_id, repo });
  }
  offset += rows.length;
  const fetched = all.length;
  if (rows.length < PAGE || (total !== null && offset >= total)) break;
  if (offset > 600) break; // safety
}

fs.writeFileSync(
  'results/swe-bench-verified-500.json',
  JSON.stringify({ count: all.length, instances: all }, null, 2),
);

// repo distribution
const byRepo = {};
for (const x of all) byRepo[x.repo] = (byRepo[x.repo] ?? 0) + 1;
const sorted = Object.entries(byRepo).sort((a, b) => b[1] - a[1]);
console.log(`total instances: ${all.length}`);
console.log('repo distribution:');
for (const [repo, n] of sorted) console.log(`  ${repo}\t${n}`);
