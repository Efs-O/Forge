#!/usr/bin/env node
// Marks every tip now in docs/CODING_TIPS.md (except those the shipped table
// resources/tips/CODING_TIPS.md already has) as reviewed, so the tips guard's
// every-tenth "Tips review due" ping counts only tips added after this review.
// Run it after the review's moves and deletions are on disk.
//
// Usage: node scripts/mark-tips-reviewed.mjs [repoRoot]
// The format and hashing live in src/llm/tipsReviewed.ts (loaded through
// Node's type stripping, Node 22.18+).
import * as fs from 'node:fs';
import * as path from 'node:path';

import { markProjectTipsReviewed, reviewedTipHashes } from '../src/llm/tipsReviewed.ts';

const root = path.resolve(process.argv[2] ?? '.');
const projectPath = path.join(root, 'docs', 'CODING_TIPS.md');
const shippedPath = path.join(root, 'resources', 'tips', 'CODING_TIPS.md');
for (const file of [projectPath, shippedPath]) {
  if (!fs.existsSync(file)) {
    console.error(`mark-tips-reviewed: no ${file}`);
    process.exit(1);
  }
}
const marked = markProjectTipsReviewed(
  fs.readFileSync(projectPath, 'utf8'),
  fs.readFileSync(shippedPath, 'utf8'),
);
fs.writeFileSync(projectPath, marked, 'utf8');
console.log(
  `mark-tips-reviewed: ${reviewedTipHashes(marked).size} project tips marked reviewed in docs/CODING_TIPS.md`,
);
