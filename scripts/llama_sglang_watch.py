#!/usr/bin/env python3
"""Daily llama.cpp / SGLang watcher for this Forge box.

Reads the cursors from docs/llama-sglang-watch.md, asks GitHub what actually
moved, runs topic discovery, checks releases, and prints a COMPACT digest plus
a ready-to-paste cursor block. It never writes the state file -- the agent does
that with edit_file, so the curated "why it matters" lines stay human.

Why it is shaped this way (each bullet cost a wasted call to learn, 2026-09-22):
  * All GitHub I/O goes through `gh api` (authenticated). Unauthenticated
    api.github.com hit a 403 rate limit mid-run.
  * `updated_at` is a useless POSITIVE signal -- a stale-close bot sweep touched
    ~25 dead llama.cpp issues in a single minute and made them all look new.
    But it is a perfect NEGATIVE signal: a cursor is recorded from an
    updated_at, so updated_at never goes backwards. `updated_at <= cursor`
    therefore PROVES nothing happened, with no extra call.
  * The whole watched list is resolved in ONE batched GraphQL call per repo via
    `repository.issue(number:)` (PRs are issues, so they resolve too).
  * `body` rejects `maxLength`, and `... on PullRequest` cannot be spread inside
    `Issue` -- so merged_at comes from a REST `pulls/N` fetch, only for threads
    that actually moved.
  * Topic matching needs word boundaries: bare "pp"/"tg" matched every item.
  * Never fetch a compare `.diff` for release notes; commit titles are the answer.

Typical cost: ~2 GraphQL + 2 search + 2 releases + a few detail calls, and the
digest printed into context stays small because raw JSON never reaches it.

Usage:
  python scripts/llama_sglang_watch.py
  python scripts/llama_sglang_watch.py --since 2026-09-21
  python scripts/llama_sglang_watch.py --no-comments --no-releases   # cheapest
"""

import argparse
import datetime
import io
import json
import re
import subprocess
import sys

# Windows default codepage (cp1253 here) cannot encode model titles we print.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

REPOS = {"llama.cpp": ("ggml-org", "llama.cpp"), "sglang": ("sgl-project", "sglang")}

# Relevance topics from the state file, bounded where the token is short.
TOPIC_RE = re.compile(
    r"qwen\s?3\.8|qwen3_5|qwen35|qwen\s?4|qwen4exp|flash.?next|flashnext"
    r"|glm\s?-?\s?5|glm5|nextn|\bmtp\b|dflash|dspark|speculat|sparse fa"
    r"|flash attention|\bnccl\b|multi-?gpu|split-?mode|layer split|\bvram\b"
    r"|\bttft\b|prefill|recurrent|\bgdn\b|\bple\b|kv-?unified"
    r"|context checkpoint|prompt cache|\bcuda\b|\bcheckpoint", re.I)

# TOP-priority per the relevance model: Flash-Next DFlash2/DSpark and friends.
PRIORITY_RE = re.compile(r"dflash|dspark|flash.?next|qwen4exp|qwen\s?3\.8|\bglm\s?-?\s?5|nextn|\bmtp\b", re.I)

# Bookkeeping-only comment authors: never count as activity.
BOTS = ("github-actions[bot]", "dependabot[bot]", "codecov[bot]", "greenday[bot]")

ISO = "%Y-%m-%dT%H:%M:%SZ"
FLAT = re.compile(r"\s+")


def run(cmd, timeout=180):
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:3])}: {p.stderr.strip()[:280]}")
    return p.stdout


def gh(*args, timeout=120):
    return json.loads(run(["gh", "api", *args], timeout=timeout))


def gh_pages(*args, timeout=180):
    """`gh api --paginate` yields concatenated JSON docs; merge their items."""
    raw = run(["gh", "api", *args, "--paginate"], timeout=timeout).strip()
    dec, i, out = json.JSONDecoder(), 0, []
    while i < len(raw):
        while i < len(raw) and raw[i] in " \r\n\t":
            i += 1
        if i >= len(raw):
            break
        doc, i = dec.raw_decode(raw, i)
        out.extend(doc.get("items", []))
    return out


def one_line(s, n=100):
    return FLAT.sub(" ", s or "")[:n]


def parse_cursors(path):
    """Pull the fenced cursor block out of the state file."""
    text = open(path, encoding="utf-8").read()
    m = re.search(r"## Cursors.*?```(.*?)```", text, re.S)
    if not m:
        raise RuntimeError(f"no cursor block found in {path}")
    cur = {}
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        mm = re.match(r"^([\w.\-#]+):\s*(.+)$", line)
        if mm:
            cur[mm.group(1)] = mm.group(2).strip()
    return cur


def watched(cursors):
    """{repo: {number: cursor_iso}} from keys shaped like 'sglang#38642'."""
    out = {}
    for key, val in cursors.items():
        mm = re.match(r"^(llama\.cpp|sglang)#(\d+)$", key)
        if mm:
            out.setdefault(mm.group(1), {})[int(mm.group(2))] = val
    return out


def topics(text):
    return sorted({h.lower().strip() for h in TOPIC_RE.findall(text or "")})
def gh_token():
    return run(["gh", "auth", "token"]).strip()


def resolve_watched(repo_key, numbers):
    """ONE batched GraphQL call -> {number: item} for every watched thread.

    Each number gets two aliased fields (issue + pullRequest); whichever is
    non-null is the item -- the schema does not unify them, and querying the
    wrong kind yields a NOT_FOUND error in `errors` while the right kind still
    returns data. `gh api graphql` would treat that error as fatal (exit 1),
    so we POST to the endpoint directly with the gh token. `comments(last:1)`
    returns the NEWEST comment (connections default to ascending; `last` takes
    the end).
    """
    import urllib.request
    owner, name = REPOS[repo_key]
    fields = []
    for n in numbers:
        sel = (" number title state updatedAt createdAt closedAt "
               "comments(last:1){ totalCount nodes{ author{ login } createdAt } }")
        fields.append(f"i{n}: issue(number:{n}){{{sel}}}")
        fields.append(f"p{n}: pullRequest(number:{n}){{ merged mergedAt{sel}}}")
    q = '{ repository(owner:"%s", name:"%s") {%s} }' % (owner, name, " ".join(fields))
    body = json.dumps({"query": q}).encode()
    req = urllib.request.Request(
        "https://api.github.com/graphql",
        data=body,
        headers={"Authorization": f"bearer {gh_token()}",
                 "User-Agent": "forge-watch", "Content-Type": "application/json"},
        method="POST")
    with urllib.request.urlopen(req, timeout=90) as r:
        res = json.loads(r.read().decode("utf-8"))
    repo = ((res.get("data") or {}).get("repository") or {})
    out = {}
    for n in numbers:
        item = repo.get(f"i{n}") or repo.get(f"p{n}")
        if item:
            out[n] = item
    return out


def newest_human_comment_from(item):
    """From a resolved item's comments(last:1): the newest non-bot comment."""
    nodes = ((item.get("comments") or {}).get("nodes")) or []
    for c in nodes:
        if (c.get("author") or {}).get("login") not in BOTS:
            return c
    return None


def search_repo(repo_key, since):
    """REST search: every thread in the repo touched since `since` (full ISO or date)."""
    q = f"repo:{REPOS[repo_key][0]}/{REPOS[repo_key][1]} updated:>={since}"
    items = gh_pages("search/issues", "-X", "GET", "-f", f"q={q}",
                     "-f", "sort=updated", "-f", "order=desc", "-f", "per_page=100")
    return {it["number"]: it for it in items}


def releases(repo_key, n=3):
    owner, name = REPOS[repo_key]
    res = gh(f"repos/{owner}/{name}/releases", "-X", "GET", "-f", f"per_page={n}")
    return [{"tag": r["tag_name"], "published": r.get("published_at"),
             "prerelease": r.get("prerelease"), "name": (r.get("name") or "")[:50]} for r in res]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", default="docs/llama-sglang-watch.md")
    ap.add_argument("--since", default=None,
                    help="discovery window start (ISO timestamp or YYYY-MM-DD; "
                         "default = the discovery_scanned_to cursor)")
    ap.add_argument("--no-comments", action="store_true", help="skip the newest-comment detail")
    ap.add_argument("--no-releases", action="store_true")
    args = ap.parse_args()

    cursors = parse_cursors(args.state)
    watch = watched(cursors)
    now = datetime.datetime.now(datetime.timezone.utc).strftime(ISO)
    since = args.since or cursors.get("discovery_scanned_to", now)

    print(f"# watch digest @ {now} | discovery window >= {since}")
    print("# box: 2x RTX 5060 Ti 16GB + 1x RTX 3060 12GB, CUDA, global binary b11095,")
    print("#      live model qwen38-27b-mtp-ud-q4kxl-vision (MTP/nextn). CUDA only --")
    print("#      Vulkan/ROCm/SYCL/NPU/XPU/hexagon items are usually NOT our path.\n")

    new_cursors = {}
    changed = []

    for repo_key, wnum in watch.items():
        nums = list(wnum)
        try:
            data = resolve_watched(repo_key, nums)
        except RuntimeError as e:
            print(f"## {repo_key}: resolve FAILED -- {e}")
            print("   (all cursors left in place; re-run or fetch individually)\n")
            for n in nums:
                new_cursors[f"{repo_key}#{n}"] = wnum[n]
            continue
        print(f"## {repo_key}: {len(data)}/{len(nums)} watched threads resolved")
        for n in nums:
            it = data.get(n)
            key = f"{repo_key}#{n}"
            if not it:
                print(f"  !! {key}: not resolved (deleted?) -- cursor left in place")
                new_cursors[key] = wnum[n]
                continue
            cur = wnum[n]
            updated, created = it["updatedAt"], it["createdAt"]
            closed, merged = it.get("closedAt"), it.get("mergedAt")
            if cur and updated <= cur:
                new_cursors[key] = cur  # provably unchanged (updated_at never goes backwards)
                continue
            label = []
            if created > cur:
                label.append("NEW-THREAD")
            if merged and merged > cur:
                label.append("MERGED")
            if closed and closed > cur and not merged:
                label.append("CLOSED")
            detail = None
            if not label and not args.no_comments:
                detail = newest_human_comment_from(it)
                if detail and detail["createdAt"] > cur:
                    label.append("NEW-COMMENT")
                else:
                    label.append("NON-COMMENT-EDIT")  # labels/assignee/base moved updated_at
            if not label:
                label.append("UPDATED")
            act = max(t for t in [updated, created, closed or "", merged or "",
                                  (detail or {}).get("createdAt", "")] if t)
            new_cursors[key] = act
            prio = bool(PRIORITY_RE.search(it.get("title", "")))
            changed.append((key, "+".join(label), act, it.get("title", ""), prio))
            print(f"  {'*PRIORITY* ' if prio else ''}{key} [{'+'.join(label)}] "
                  f"act={act} (was {cur or 'none'}) :: {one_line(it.get('title'), 88)}")
            if detail:
                who = (detail.get("author") or {}).get("login", "?")
                print(f"      {who} {detail['createdAt']} (bot-excluded: "
                      f"{who in BOTS})")
        print()

    if changed:
        print(f"## {len(changed)} watched thread(s) with real new activity "
              f"({sum(1 for c in changed if c[4])} priority)\n")

    # ---- discovery: topic matches NOT already watched (REST search, 1 call/repo) ----
    # Tiered so the digest stays small: PRIORITY (top-priority drafter/model
    # topics) first, then the rest of the NEW-thread matches, then a capped
    # "older threads merely touched" list (usually noise -- label sweeps, CI
    # pings, stale closes -- which is why updated_at is never a positive signal).
    print("## discovery candidates (topic match, not already watched)")
    for repo_key in REPOS:
        wnum = watch.get(repo_key, {})
        try:
            found = search_repo(repo_key, since)
        except RuntimeError as e:
            print(f"  !! {repo_key}: {e}\n")
            continue
        fresh, touched = [], []
        for num, it in found.items():
            if num in wnum:
                continue
            hits = topics((it.get("title", "") + " " + (it.get("body") or "")))
            if not hits:
                continue
            pr = it.get("pull_request") or {}
            kind = "PR" if pr else "IS"
            st = it["state"] + ("/MERGED" if pr.get("merged_at") else "")
            line = (f"  [{kind} {st}] {repo_key}#{num} created={it['created_at'][:10]} "
                    f"c={it['comments']} :: {one_line(it['title'], 82)} :: {','.join(hits[:6])}")
            (fresh if it["created_at"] >= since else touched).append(line)
        prio_f = [l for l in fresh if PRIORITY_RE.search(l)]
        other_f = [l for l in fresh if not PRIORITY_RE.search(l)]
        prio_t = [l for l in touched if PRIORITY_RE.search(l)]
        print(f"  ### {repo_key}: {len(fresh)} new topic-matching threads "
              f"({len(prio_f)} PRIORITY)")
        for line in prio_f:
            print("  *PRIORITY* " + line.strip())
        for line in other_f[:15]:
            print(line)
        if len(other_f) > 15:
            print(f"  ... {len(other_f) - 15} more non-priority new threads")
        print(f"  ### {repo_key}: {len(touched)} older threads merely touched "
              f"({len(prio_t)} priority -- check those if curious)")
        for line in prio_t[:10]:
            print("  *PRIORITY* " + line.strip())
        if len(prio_t) > 10:
            print(f"  ... {len(prio_t) - 10} more priority-touched")
        print()

    # ---- releases + commit titles between seen tag and newest ----
    if not args.no_releases:
        print("## releases")
        for repo_key in REPOS:
            try:
                rel = releases(repo_key)
            except RuntimeError as e:
                print(f"  {repo_key}: !! {e}")
                continue
            for r in rel:
                print(f"  {repo_key}: {r['tag']} {r['published']} "
                      f"{'(pre)' if r['prerelease'] else ''} {r['name']}")
            seen = cursors.get(f"release_seen_{repo_key.replace('.', '')}")
            latest = rel[0]["tag"] if rel else None
            if seen and latest and seen != latest:
                print(f"  --> {repo_key} {seen} -> {latest}:")
                try:
                    cmp_ = gh(f"repos/{REPOS[repo_key][0]}/{REPOS[repo_key][1]}/compare/{seen}...{latest}")
                    for c in cmp_.get("commits", []):
                        print(f"      - {one_line(c['commit']['message'].splitlines()[0], 100)}")
                except RuntimeError as e:
                    print(f"      !! compare failed: {e}")
            elif seen and latest:
                print(f"  (no new {repo_key} release; seen {seen})")
        print()

    print("## PASTE-BACK CURSORS (merge into the Cursors block; set discovery_scanned_to)")
    for k in sorted(new_cursors):
        print(f"{k}: {new_cursors[k]}")
    print(f"discovery_scanned_to: {now}")
    print("\n## NEXT STEPS FOR THE AGENT")
    print("1. Triage the *PRIORITY* threads + NEW-thread candidates against the relevance model;")
    print("   fetch a comment only for a thread you might actually add (saves calls).")
    print("2. Append genuinely-relevant ones to the Discovered watch list WITH a cursor line,")
    print("   dedupe against the fixed list.")
    print("3. Prepend one Run log line; keep ~20. Update release_seen_* only after reading the")
    print("   new tag's commits. RESULT line per the job spec.")


if __name__ == "__main__":
    main()