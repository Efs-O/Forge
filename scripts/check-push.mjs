#!/usr/bin/env node
/**
 * The push gate. Refuses a push whose range does not read as a professional
 * repository to a stranger: message shape, process-noise subjects, release
 * commits that are only releases, a tag for every version, no merge commits,
 * only `main`/`v*` refs, no non-fast-forward of `main`, no machine identity in
 * the pushed text, and a recorded green CI for the exact tree being pushed.
 *
 * Nothing here is grandfathered: a commit that predates the rule gets a real
 * subject, because a stranger cannot tell a grandfathered subject from a lazy
 * one.
 *
 * Usage:
 *   node scripts/check-push.mjs                       # the upstream range
 *   node scripts/check-push.mjs origin/main..HEAD     # an explicit range
 *   node scripts/check-push.mjs --pre-push            # from .githooks/pre-push
 *   node scripts/check-push.mjs --record-ci           # report whether a green run is recorded
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMarker } from './record-ci-pass.mjs';

const TYPES = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore'];
const TYPE_RE = new RegExp(`^(?:${TYPES.join('|')})(\\([^()]{1,24}\\))?: \\S`);
const RELEASE_RE = /^chore\(release\): v\d+\.\d+\.\d+$/;
const VERSION_FILE = 'package.json';
const RELEASE_FILES = new Set(['package.json', 'package-lock.json', 'CHANGES.md']);
const BANNED = [
  [/^fixup!/i, 'fixup! subject — fold it with `git rebase --autosquash` before pushing'],
  [/^squash!/i, 'squash! subject — fold it before pushing'],
  [/\bwip\b/i, 'work-in-progress subject — say what the commit does'],
  [/\breview fix(es)?\b/i, 'a review-fix subject names the process, not the change — name the defect'],
  [/\baddress(es)? review\b/i, 'a review-response subject names the process, not the change'],
];
const CO_AUTHOR = /^Co-Authored-By: Forge <forge@evolvlabs\.dev>$/u;
const SCRIB_FILE = '.secrets-patterns.txt';

const args = process.argv.slice(2);
const prePush = args.includes('--pre-push');
const recordCi = args.includes('--record-ci');
const rangeArg = args.find((a) => a.includes('..'));

function git(...cmd) {
  return execFileSync('git', cmd, { encoding: 'utf8' });
}

// The pre-push hook tells us on stdin exactly what is being pushed:
// "<local_ref> <local_sha> <remote_ref> <remote_sha>" per line. Checking the
// pushed commits themselves, and not HEAD's upstream, is what makes
// `git push origin other:main` get the gate it deserves.
function prePushTargets() {
  const input = readFileSync(0, 'utf8').trim();
  const targets = [];
  for (const line of input.split('\n').filter(Boolean)) {
    const [, localSha, remoteRef, remoteSha] = line.split(/\s+/);
    if (!/^refs\/(heads\/main|tags\/v.+)/u.test(remoteRef)) {
      targets.push({ remoteRef, error: `refusing to push ${remoteRef} — only main and v* tags go to the remote` });
      continue;
    }
    const absent = !remoteSha || /^0+$/u.test(remoteSha);
    if (remoteRef === 'refs/heads/main' && !absent) {
      try {
        git('merge-base', '--is-ancestor', remoteSha, localSha);
      } catch {
        targets.push({ remoteRef, error: `${remoteRef} is not a fast-forward — pull or rebase, do not force` });
        continue;
      }
    }
    targets.push({
      remoteRef,
      localSha,
      range: absent ? localSha : `${remoteSha}..${localSha}`,
    });
  }
  return targets;
}

const targets = prePush ? prePushTargets() : [];
const mainTarget = targets.find((t) => t.remoteRef === 'refs/heads/main' && !t.error);
const pushSha = mainTarget ? mainTarget.localSha : git('rev-parse', 'HEAD').trim();
const treeHash = git('rev-parse', `${pushSha}^{tree}`).trim();
const markerDir = join('.forge', 'ci-pass');

if (recordCi) {
  // Report-only since 0.17.167. This block used to write the marker without running anything,
  // and on 2026-11-12 a green pass was recorded over a red suite, which the gate could not see.
  // The proof is now written by `npm run ci:steps` (see scripts/record-ci-pass.mjs), which is
  // reached only when every step before it exited 0.
  const recorded = readMarker(markerDir, treeHash);
  if (recorded) {
    console.log(
      `check-push: a green CI run is recorded for tree ${treeHash.slice(0, 12)} (at ${recorded.at}) — nothing to record`,
    );
    process.exit(0);
  }
  console.error(
    `check-push: no recorded CI pass for tree ${treeHash.slice(0, 12)} — \`npm run ci\` records it itself; --record-ci no longer creates one`,
  );
  process.exit(1);
}

function upstreamRange() {
  try {
    return git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}').trim() + '..HEAD';
  } catch {
    return null;
  }
}

const problems = [];
const warnings = [];

const range = rangeArg ?? (mainTarget ? mainTarget.range : upstreamRange());
if (!range) {
  console.error('check-push: no upstream configured; pass a range, e.g. origin/main..HEAD');
  process.exit(1);
}

const commits = git('rev-list', range).trim().split('\n').filter(Boolean);
if (commits.length === 0) {
  console.log(`check-push: ${range} is empty — nothing to check`);
  process.exit(0);
}

// 1. Message shape, process-noise subjects, authorship trailer.
const records = git('log', '--format=%H%x1f%s%x1f%b%x1f%an%x1e', range)
  .trim()
  .split('\x1e')
  .map((r) => r.trim())
  .filter(Boolean)
  .map((r) => {
    const [sha, subject, body, author] = r.split('\x1f');
    return {
      sha: sha ?? '',
      subject: (subject ?? '').trim(),
      body: body ?? '',
      author: (author ?? '').trim(),
    };
  });

let configuredEmail = '';
try {
  configuredEmail = git('config', 'user.email').trim();
} catch {
  /* no configured identity */
}

for (const { sha, subject, body, author } of records) {
  const short = sha.slice(0, 8);
  const isRelease = RELEASE_RE.test(subject);
  if (!isRelease) {
    if (!TYPE_RE.test(subject)) {
      problems.push(`${short}: subject must be \`type(scope): summary\` — got "${subject}"`);
    }
    if (subject.length > 100) {
      problems.push(`${short}: subject is ${String(subject.length)} chars, max 100 — "${subject}"`);
    }
    if (/[.]$/.test(subject)) problems.push(`${short}: subject ends with a period`);
  }
  for (const [re, why] of BANNED) {
    if (re.test(subject)) problems.push(`${short}: ${why} — "${subject}"`);
  }
  if (/^Release /.test(subject) && !isRelease) {
    problems.push(
      `${short}: "Release ..." must be the release spelling \`chore(release): vX.Y.Z\`, or name the change — "${subject}"`,
    );
  }
  // The owner's rule: every commit message ends with exactly one Forge
  // co-author trailer, on its own after a blank line.
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const trailers = lines.filter((l) => CO_AUTHOR.test(l));
  if (trailers.length !== 1) {
    problems.push(
      `${short}: expected exactly one \`Co-Authored-By: Forge <forge@evolvlabs.dev>\` trailer, found ${String(trailers.length)}`,
    );
  } else if (!CO_AUTHOR.test(lines[lines.length - 1] ?? '')) {
    problems.push(`${short}: the Forge co-author trailer must be the last line of the message`);
  }
  if (/^(claude|codex|qwopus|forge agent)\b/iu.test(author)) {
    problems.push(`${short}: author is "${author}" — commits carry the owner's identity`);
  }
  if (configuredEmail) {
    const email = git('log', '-1', '--format=%e', sha).trim();
    if (email && email !== configuredEmail) {
      warnings.push(`${short}: authored by ${email}, not the configured ${configuredEmail}`);
    }
  }
}

// 2. Merge commits.
const merges = git('rev-list', '--merges', '--count', range).trim();
if (merges !== '0') problems.push(`${merges} merge commit(s) in ${range} — rebase instead of merging`);

// 3. Every commit that changes the version must be a clean release commit.
const versionCommits = git('log', '--format=%H %s', `-G"version": "`, range, '--', VERSION_FILE)
  .trim()
  .split('\n')
  .filter(Boolean);
for (const entry of versionCommits) {
  const sha = entry.split(' ')[0];
  const subject = git('log', '-1', '--format=%s', sha).trim();
  const body = git('log', '-1', '--format=%b', sha);
  // A commit that deliberately carries a version bump says why. The exemption
  // is loud (a warning on every push) so a stranger can still see it.
  const exempt = /Push-Hygiene-Exempt:\s*(.+)/u.exec(body);
  if (exempt) {
    if (exempt[1].trim().length < 10) {
      problems.push(`${sha.slice(0, 8)}: Push-Hygiene-Exempt needs a reason of at least 10 characters`);
    }
    warnings.push(
      `${sha.slice(0, 8)}: release-shape check skipped by exemption — ${exempt[1].trim()}`,
    );
    continue;
  }
  if (!RELEASE_RE.test(subject)) {
    problems.push(`${sha.slice(0, 8)}: changes the version but is not \`chore(release): vX.Y.Z\` — "${subject}"`);
    continue;
  }
  const files = git('show', '--name-only', '--format=', sha)
    .trim()
    .split('\n')
    .filter(Boolean);
  const extra = files.filter((f) => !RELEASE_FILES.has(f));
  if (extra.length) {
    const shown = extra.slice(0, 5).join(', ');
    problems.push(
      `${sha.slice(0, 8)}: release commit also touches ${extra.length} other file(s) (${shown}${extra.length > 5 ? ', …' : ''}) — keep code out of releases`,
    );
  }
}

// 4. A tag for the version being pushed.
let version;
try {
  version = JSON.parse(readFileSync(VERSION_FILE, 'utf8')).version;
} catch {
  /* package.json unreadable */
}
if (version) {
  try {
    git('rev-parse', '-q', '--verify', `refs/tags/v${version}`);
  } catch {
    problems.push(`no tag v${version} locally — tag the release and push the tag with it`);
  }
}

// 5. A recorded green CI for this exact tree. An unreadable or malformed marker is not a
// proof either, so the gate asks readMarker rather than trusting the file's existence.
if (!readMarker(markerDir, treeHash)) {
  if (process.env.FORGE_PUSH_SKIP_CI === '1') {
    warnings.push('no recorded CI pass for this tree, and FORGE_PUSH_SKIP_CI=1');
  } else {
    problems.push(
      `no recorded CI pass for tree ${treeHash.slice(0, 12)} — run \`npm run ci\` after the commit it certifies; the run records the pass itself`,
    );
  }
}

// 6. Machine identity in the pushed text. Textconv is off so the scan reads
// the bytes being pushed, and a document converter cannot spam stderr.
if (existsSync(SCRIB_FILE)) {
  const patterns = readFileSync(SCRIB_FILE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (patterns.length) {
    const text = execFileSync('git', ['log', '--no-textconv', '--no-ext-diff', '--patch', range], {
      encoding: 'utf8',
      maxBuffer: 200 * 1024 * 1024,
    });
    for (const p of patterns) {
      let re;
      try {
        re = new RegExp(p, 'iu');
      } catch {
        problems.push(`${SCRIB_FILE}: bad pattern "${p}"`);
        continue;
      }
      if (re.test(text)) problems.push(`the pushed text still contains a match for "${p}" — scrub it before pushing`);
    }
  }
} else {
  warnings.push(`${SCRIB_FILE} is absent — the identity scrub did not run`);
}

// 7. Refs and fast-forward, when driven by the pre-push hook.
for (const t of targets) {
  if (t.error) problems.push(`check-push: ${t.error}`);
}

for (const w of warnings) console.warn(`check-push: warn: ${w}`);
if (problems.length) {
  for (const p of problems) console.error(`check-push: ${p}`);
  console.error(`check-push: ${problems.length} problem(s) in ${range} (${commits.length} commits)`);
  process.exit(1);
}
console.log(`check-push: ${range} is clean (${commits.length} commits, tree ${treeHash.slice(0, 12)})`);
