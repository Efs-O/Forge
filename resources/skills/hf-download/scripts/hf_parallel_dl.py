"""Fast Hugging Face downloads: each large file is split into parallel HTTP range requests.

Why: on this PC one HF connection gets ~2 MB/s, `hf download` uses one connection per file, and the hf_xet path
has stalled at 0 bytes. 12 range connections fetched an 8 GB file in 77 s (~104 MB/s) on 2026-10-24.

Every file is checked when it is done: LFS files against the SHA-256 that the Hub publishes for them, small (git)
files against their git blob SHA-1. A stopped download resumes: rerun the same command.

Examples:
  python N:\\models\\tools\\hf_parallel_dl.py ISTA-DASLab/DeepSeek-V4.1-Flash-1017-GSQ-RCO-GGUF ^
      DeepSeek-V4.1-Flash-Engram-IQ4_NL.gguf --dest N:\\models\\DeepSeek
  python N:\\models\\tools\\hf_parallel_dl.py unsloth/Some-GGUF --include "Q4_K_M/*.gguf" --dest N:\\models\\Some --flat
  python N:\\models\\tools\\hf_parallel_dl.py org/repo file.gguf --dest D:\\x --revision 0123abc --sha256 file.gguf=<hex>

Standard library only. Token (optional, raises the Hub's rate limits): HF_TOKEN, else %HF_HOME%\\token, else
~/.cache/huggingface/token. The token is sent to huggingface.co only, never to the CDN it redirects to.
"""
import argparse
import fnmatch
import hashlib
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

HUB = "https://huggingface.co"
UA = "hf_parallel_dl/1.0"
SMALL = 64 << 20          # below this a file is fetched over one connection
CHUNK = 1 << 20
SAVE_EVERY = 5            # seconds between resume-state saves
REPORT_EVERY = 15         # seconds between progress lines

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")   # a cp1252 console must never crash a finished download


def log(msg):
    print(time.strftime("[%H:%M:%S] ") + msg, flush=True)


def read_token():
    if os.environ.get("HF_TOKEN"):
        return os.environ["HF_TOKEN"].strip()
    home = os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface")
    path = os.path.join(home, "token")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            return f.read().strip() or None
    return None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def request(url, headers=None, data=None, timeout=60):
    """One HTTP call; waits out a 429 (Retry-After) instead of hammering the Hub."""
    for _ in range(10):
        req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
        try:
            return OPENER.open(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308):
                return e
            if e.code == 429:
                wait = int(e.headers.get("Retry-After") or 30)
                log(f"rate limited by the Hub (429): waiting {wait} s")
                time.sleep(wait)
                continue
            raise
    raise RuntimeError(f"still rate limited after 10 waits: {url}")


def hub_json(url, token, data=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    with request(url, headers, data) as r:
        body = r.read()
        link = r.headers.get("Link") or ""
    return json.loads(body), link


def api_base(repo_type, repo):
    return f"{HUB}/api/{repo_type}s/{repo}"


def list_tree(repo_type, repo, rev, token):
    url = f"{api_base(repo_type, repo)}/tree/{urllib.parse.quote(rev, safe='')}?recursive=true&expand=false"
    out = []
    while url:
        items, link = hub_json(url, token)
        out += [i["path"] for i in items if i.get("type") == "file"]
        url = None
        for part in link.split(","):
            if 'rel="next"' in part:
                url = part[part.index("<") + 1:part.index(">")]
    return out


def paths_info(repo_type, repo, rev, paths, token):
    """size, and the expected hash: ('sha256', hex) for LFS files, ('git-sha1', hex) for plain git files."""
    url = f"{api_base(repo_type, repo)}/paths-info/{urllib.parse.quote(rev, safe='')}"
    info = {}
    for i in range(0, len(paths), 50):
        data = urllib.parse.urlencode([("paths", p) for p in paths[i:i + 50]] + [("expand", "false")]).encode()
        items, _ = hub_json(url, token, data)
        for it in items:
            if it.get("type") != "file":
                continue
            lfs = it.get("lfs")
            if lfs:
                info[it["path"]] = (lfs["size"], ("sha256", lfs.get("sha256") or lfs["oid"]))
            else:
                info[it["path"]] = (it["size"], ("git-sha1", it["oid"]))
    return info


def resolve_url(repo_type, repo, rev, path, token):
    """The final (CDN) URL of a file. Redirects are followed by hand so the token never leaves huggingface.co."""
    prefix = "" if repo_type == "model" else f"/{repo_type}s"
    url = f"{HUB}{prefix}/{repo}/resolve/{urllib.parse.quote(rev, safe='')}/{urllib.parse.quote(path)}"
    for _ in range(10):
        host = urllib.parse.urlparse(url).hostname or ""
        headers = {"Range": "bytes=0-0"}
        if token and (host == "huggingface.co" or host.endswith(".huggingface.co")):
            headers["Authorization"] = f"Bearer {token}"
        r = request(url, headers)
        with r:
            if r.status in (301, 302, 303, 307, 308) or getattr(r, "code", 0) in (301, 302, 303, 307, 308):
                url = urllib.parse.urljoin(url, r.headers["Location"])
                continue
            if r.status not in (200, 206):
                raise RuntimeError(f"{path}: HTTP {r.status}")
            if r.status == 200:
                raise RuntimeError(f"{path}: the server ignores range requests (HTTP 200 to a range)")
            return url
    raise RuntimeError(f"{path}: too many redirects")


def file_hash(path, kind, size):
    h = hashlib.sha256() if kind == "sha256" else hashlib.sha1()
    if kind == "git-sha1":
        h.update(f"blob {size}\0".encode())
    with open(path, "rb") as f:
        while b := f.read(1 << 24):
            h.update(b)
    return h.hexdigest()


class Download:
    def __init__(self, args, path, size, expected, token):
        self.a, self.path, self.size, self.expected, self.token = args, path, size, expected, token
        name = os.path.basename(path) if args.flat else path
        self.final = os.path.join(args.dest, *name.split("/"))
        self.tmp = self.final + ".dl"
        self.state_file = self.final + ".dl.json"
        self.lock = threading.Lock()
        self.url = None
        self.done_event = threading.Event()

    def plan(self):
        n = 1 if self.size < SMALL else max(1, self.a.parts)
        step = -(-self.size // n) if self.size else 0
        fresh = [[i * step, min(self.size, (i + 1) * step) - 1, i * step] for i in range(n) if i * step < self.size]
        if os.path.isfile(self.tmp) and os.path.isfile(self.state_file) and os.path.getsize(self.tmp) == self.size:
            try:
                with open(self.state_file, encoding="utf-8") as f:
                    st = json.load(f)
                if st.get("size") == self.size and st.get("expected") == list(self.expected):
                    parts = [p for p in st["parts"]]
                    have = sum(p[2] - p[0] for p in parts)
                    log(f"{self.path}: resuming, {have / 1e9:.2f} of {self.size / 1e9:.2f} GB already here")
                    # Split what is left back into n connections: finished parts drop out, the biggest gap halves.
                    while len([p for p in parts if p[2] <= p[1]]) < n:
                        gap = max(parts, key=lambda p: p[1] - p[2] + 1)
                        left = gap[1] - gap[2] + 1
                        if left < 2 * CHUNK:
                            break
                        mid = gap[2] + left // 2
                        parts.append([mid, gap[1], mid])
                        gap[1] = mid - 1
                    return parts
            except (OSError, ValueError, KeyError):
                pass
        os.makedirs(os.path.dirname(self.final) or ".", exist_ok=True)
        with open(self.tmp, "wb") as f:
            f.truncate(self.size)
        return fresh

    def save(self, parts):
        with self.lock:
            snap = [list(p) for p in parts]
        tmp = self.state_file + ".new"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"size": self.size, "expected": list(self.expected), "parts": snap}, f)
        os.replace(tmp, self.state_file)

    def fresh_url(self, stale=None):
        with self.lock:
            if self.url is None or self.url == stale:
                self.url = resolve_url(self.a.repo_type, self.a.repo, self.a.revision, self.path, self.token)
            return self.url

    def worker(self, part, errors):
        for attempt in range(30):
            start, end, pos = part
            if pos > end:
                return
            url = self.fresh_url()
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA, "Range": f"bytes={pos}-{end}"})
                with OPENER.open(req, timeout=60) as r, open(self.tmp, "r+b") as f:
                    if r.status != 206:
                        raise RuntimeError(f"HTTP {r.status} to a range request")
                    f.seek(pos)
                    while b := r.read(CHUNK):
                        f.write(b)
                        with self.lock:
                            part[2] += len(b)
                if part[2] > end:
                    return
            except urllib.error.HTTPError as e:
                if e.code in (401, 403, 410):          # a signed CDN URL that expired: ask the Hub for a new one
                    self.fresh_url(stale=url)
                wait = int(e.headers.get("Retry-After") or 30) if e.code == 429 else min(60, 3 * (attempt + 1))
                log(f"{self.path}: bytes {part[2]}-{end}: HTTP {e.code}, retry in {wait} s")
                time.sleep(wait)
            except Exception as e:  # noqa: BLE001 - network errors are retried, then reported
                log(f"{self.path}: bytes {part[2]}-{end}: {e}, retry in {min(60, 3 * (attempt + 1))} s")
                time.sleep(min(60, 3 * (attempt + 1)))
        errors.append(part)

    def run(self):
        if os.path.isfile(self.final) and os.path.getsize(self.final) == self.size:
            log(f"{self.path}: already here")
        else:
            parts = self.plan()
            errors = []
            t0 = time.time()
            base = sum(p[2] - p[0] for p in parts)
            threads = [threading.Thread(target=self.worker, args=(p, errors), daemon=True) for p in parts]
            for t in threads:
                t.start()
            last_save = last_report = time.time()
            try:
                while any(t.is_alive() for t in threads):
                    time.sleep(1)
                    now = time.time()
                    if now - last_save >= SAVE_EVERY:
                        self.save(parts)
                        last_save = now
                    if now - last_report >= REPORT_EVERY:
                        have = sum(p[2] - p[0] for p in parts)
                        rate = (have - base) / max(1e-9, now - t0) / 1e6
                        log(f"{self.path}: {have / 1e9:.2f} / {self.size / 1e9:.2f} GB, {rate:.0f} MB/s")
                        last_report = now
            finally:
                self.save(parts)
            if errors:
                raise RuntimeError(f"{self.path}: {len(errors)} part(s) failed after 30 tries; rerun to resume")
            dt = time.time() - t0
            log(f"{self.path}: {(self.size - base) / 1e9:.2f} GB in {dt:.0f} s ({(self.size - base) / max(dt, 1e-9) / 1e6:.0f} MB/s)")
            os.replace(self.tmp, self.final)
            os.remove(self.state_file)
        if self.a.no_verify:
            log(f"{self.path}: not verified (--no-verify)")
            return
        kind, want = self.expected
        got = file_hash(self.final, kind, self.size)
        if got.lower() != want.lower():
            raise RuntimeError(f"{self.path}: {kind} {got} does not match the expected {want}; the file is kept at "
                               f"{self.final} - delete it and run again")
        log(f"{self.path}: {kind} OK")


def main():
    ap = argparse.ArgumentParser(description="Parallel ranged Hugging Face downloads with resume and hash checks.")
    ap.add_argument("repo", help="org/name")
    ap.add_argument("files", nargs="*", help="paths inside the repo (as the Hub lists them, sub-folders included)")
    ap.add_argument("--include", action="append", default=[], help="glob over the repo's files (repeatable)")
    ap.add_argument("--dest", required=True, help="folder to download into")
    ap.add_argument("--revision", default="main", help="branch, tag or commit (default main; a commit pins it)")
    ap.add_argument("--repo-type", choices=["model", "dataset", "space"], default="model")
    ap.add_argument("--parts", type=int, default=12, help="parallel connections per large file (default 12; keep 8-16)")
    ap.add_argument("--flat", action="store_true", help="put every file directly in --dest, without its repo sub-folder")
    ap.add_argument("--sha256", action="append", default=[], metavar="FILE=HEX",
                    help="expected SHA-256 for a file, overriding the Hub's (repeatable)")
    ap.add_argument("--no-verify", action="store_true", help="skip the hash check")
    a = ap.parse_args()
    if not a.files and not a.include:
        ap.error("name at least one file or --include pattern")
    if not 1 <= a.parts <= 32:
        ap.error("--parts must be 1..32")
    token = read_token()
    files = list(a.files)
    if a.include:
        tree = list_tree(a.repo_type, a.repo, a.revision, token)
        matched = [p for p in tree if any(fnmatch.fnmatch(p, g) for g in a.include)]
        if not matched:
            raise SystemExit(f"no file in {a.repo}@{a.revision} matches {a.include}")
        files += [p for p in matched if p not in files]
    info = paths_info(a.repo_type, a.repo, a.revision, files, token)
    missing = [p for p in files if p not in info]
    if missing:
        raise SystemExit(f"not in {a.repo}@{a.revision}: {', '.join(missing)}")
    overrides = dict(s.split("=", 1) for s in a.sha256)
    total = sum(info[p][0] for p in files)
    log(f"{a.repo}@{a.revision}: {len(files)} file(s), {total / 1e9:.2f} GB -> {a.dest}"
        f"{' (token)' if token else ' (anonymous)'}")
    for p in files:
        size, expected = info[p]
        name = os.path.basename(p)
        if p in overrides or name in overrides:
            expected = ("sha256", overrides.get(p) or overrides[name])
        Download(a, p, size, expected, token).run()
    log("ALL OK")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("stopped; rerun the same command to resume")
        sys.exit(130)
    except Exception as e:  # noqa: BLE001 - one plain line, nonzero exit
        log(f"FAILED: {e}")
        sys.exit(1)
