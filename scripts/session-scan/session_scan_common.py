"""Shared argument handling for the scripts/session-scan/ scripts.

These scripts used to live in scratch/, where the sessions folder, the output
folder, the window start and the set of probe chats were hard-coded to one
machine and one week. A weekly job needs all of them as arguments, so they
move here. The individual scan algorithms stay in their own scripts.

Shared log-text interpretation and argument helpers live here as well as the
UTF-8 / '\n' output writer, so the scanners use the same failure boundaries.
"""

import argparse
import collections
import json
import os
import re
import sys
import time
from datetime import date, timedelta
from pathlib import Path

# Where Forge writes its session logs on any machine.
SESSIONS = Path.home() / '.forge' / 'sessions'
# scripts/session-scan/x.py -> scripts -> repository root.
REPO_ROOT = Path(__file__).resolve().parents[2]

# Output names, so scan scripts cannot disagree about who writes what.
OUT_FILES = {
    'raw': 'failed_tools_raw.txt',
    'sig': 'failed_tools_sig.txt',
    'summary': 'scan_summary.txt',
    'cutoff': 'scan_cutoff.txt',
    'recovery': 'recovery.txt',
    'spot': 'failed_tools_spot.txt',
    'versions': 'failed_tools_versions.txt',
    'repeats': 'tips_repeats.txt',
    'rate': 'failed_tools_rate.txt',
    'rate_by_model': 'failed_tools_rate_by_model.txt',
    'sig_outside': 'failed_tools_sig_outside.txt',
    'struggles': 'struggle_patterns.txt',
}


def txt_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict):
                parts.append(str(b.get('text') or b.get('content') or ''))
            else:
                parts.append(str(b))
        return '\n'.join(parts)
    return str(content)


def bucket(first):
    f = first.strip()
    if f.startswith('User declined') or f.startswith('Denied') or 'declined:' in f[:40].lower():
        return 'USER_DECLINED'
    if f.startswith('unattended:'):
        return 'UNATTENDED_DENIED'
    if f.startswith('Error:') or f.startswith('REFUSED'):
        return 'TOOL_ERROR'
    m = re.match(r'^exit (\d+)', f)
    if m and int(m.group(1)) > 0:
        return 'SHELL_NONZERO'
    if re.match(r'^(Tool .*failed|Failed)', f):
        return 'TOOL_ERROR'
    return None


def sig(t):
    s = re.sub(r'\d+', 'N', t)
    s = re.sub(r'[`"\x27]', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s[:110]


def parse(description):
    p = argparse.ArgumentParser(description=description)
    p.add_argument(
        '--sessions',
        type=Path,
        default=SESSIONS,
        help='folder of *.jsonl session logs (default: %(default)s)',
    )
    p.add_argument(
        '--out',
        type=Path,
        required=True,
        help='folder the outputs go to; created if missing',
    )
    p.add_argument(
        '--since',
        metavar='YYYY-MM-DD',
        help='window start; default is 7 days before now',
    )
    p.add_argument(
        '--since-cutoff',
        metavar='FILE',
        help='file holding the epoch seconds to start the window at: a previous run\'s '
        'scan_cutoff.txt; cannot be combined with --since',
    )
    p.add_argument(
        '--min-version',
        metavar='X.Y.Z',
        help='leave out every tool row that ran on an older Forge build; '
        'default is to count every build',
    )
    p.add_argument(
        '--exclude',
        type=Path,
        metavar='FILE',
        help='chat-id prefixes to leave out of the production counts, one per line; '
        'default is to exclude nothing',
    )
    args = p.parse_args()
    if args.since and args.since_cutoff:
        sys.exit('use --since or --since-cutoff, not both')
    if args.since_cutoff:
        # Checked here as well as in start_epoch, so a bad path is refused before
        # any script has read a thousand logs looking for nothing.
        read_since_cutoff(args.since_cutoff)
    return args


def need_sessions(sessions):
    if not Path(sessions).is_dir():
        sys.exit(f'no sessions folder at {sessions}')


def session_files(sessions):
    """The *.jsonl logs, in a fixed order so a re-run is comparable."""
    return sorted(str(p) for p in Path(sessions).glob('*.jsonl'))


def read_since_cutoff(path):
    """The window start stored in a previous run's scan_cutoff.txt: one float.

    The job runs twice a week, and each run should count only what happened since
    the previous one. A run saves its frozen end in scan_cutoff.txt, so the next
    run starts the window at that same moment: no gap, no overlap.
    """
    try:
        return float(Path(path).read_text(encoding='utf-8').strip())
    except Exception:
        sys.exit(f'--since-cutoff: cannot read {path}')


def _ver_tuple(v):
    """'0.17.204' -> (0, 17, 204); None when it is not dotted integers."""
    if not isinstance(v, str):
        return None
    parts = v.strip().lstrip('vV').split('.')
    if parts == ['']:
        return None
    out = []
    for part in parts:
        if not part.isdigit():
            return None
        out.append(int(part))
    return tuple(out)


def version_ok(version, min_version):
    """True when this Forge build is one the run should count.

    No minimum means every build counts. Otherwise the two dotted versions compare
    as integer tuples, so 0.17.204 passes a minimum of 0.17.204 and 0.17.196 does
    not. A version of '?' — what every script here uses for a missing one — or one
    that does not parse answers False: an unknown build is left out rather than
    folded into the current one.
    """
    if not min_version:
        return True
    have = _ver_tuple(version)
    want = _ver_tuple(min_version)
    if have is None or want is None:
        return False
    return have >= want


def start_epoch(since, since_cutoff=None):
    """--since-cutoff's stored value, else --since, else 7 days before now.

    --since means local midnight on that day; --since-cutoff is an exact moment, so
    two runs never count the same call or miss one between them.
    """
    if since_cutoff:
        return read_since_cutoff(since_cutoff)
    if since:
        try:
            return time.mktime(time.strptime(since + ' 00:00:00', '%Y-%m-%d %H:%M:%S'))
        except ValueError:
            sys.exit(f'--since must be YYYY-MM-DD, not {since}')
    day = date.today() - timedelta(days=7)
    return time.mktime(time.strptime(day.isoformat() + ' 00:00:00', '%Y-%m-%d %H:%M:%S'))


def read_cutoff(out_dir):
    """The frozen window end.

    One frozen cutoff, shared by every script that reads these logs. Both auditors
    found the old report quoting figures taken from three different moments; re-running
    reuses this value instead of drifting forward, so one number means one thing.
    """
    end = time.time()
    cut_file = Path(out_dir) / OUT_FILES['cutoff']
    if cut_file.exists():
        try:
            end = float(cut_file.read_text(encoding='utf-8').strip())
        except Exception:
            pass
    return end


def freeze_cutoff(out_dir, end):
    """scan_logs.py only: save the end so the other scripts read the same value."""
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    (Path(out_dir) / OUT_FILES['cutoff']).write_text(repr(end), encoding='utf-8', newline='\n')


def window(args):
    """(start_epoch, frozen_end_epoch) for this run."""
    return start_epoch(args.since, args.since_cutoff), read_cutoff(args.out)


def exclude_set(exclude_file):
    """Chat-id prefixes to leave out of the production counts; empty by default."""
    if not exclude_file:
        return set()
    lines = Path(exclude_file).read_text(encoding='utf-8').splitlines()
    return {ln.split()[0] for ln in lines if ln.strip() and not ln.lstrip().startswith('#')}


def excluded(sid, prefixes):
    return any(sid.startswith(p) for p in prefixes)


def is_forge_workspace(name):
    """True when a chat's `workspace_name` is one of Forge's own checkouts.

    `session_start` rows carry an optional `workspace_name`; a chat that predates
    the field reports '?', which counts as NOT Forge: the point of the column is
    to show where an outside mistake belongs, and an unknown workspace is treated
    as outside. Matching is by lower-cased name, so `Forge`, `forge`,
    `Forge-lab2`, `forge-relay` and `forge-sectest-1028` all answer True.
    """
    ws = (name or '').strip().lower()
    return ws == 'forge' or ws.startswith('forge-')


def writer(out_dir, name, mode='w'):
    """Open one of the named output files, UTF-8 and '\n', creating the folder."""
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    return open(Path(out_dir) / OUT_FILES[name], mode, encoding='utf-8', newline='\n')


def day_index(start, end):
    """Map '%a %d' -> start-of-day epoch ms, for every day in the window.

    The raw file stamps a failure only as 'Wed 04 15:30' — no year, no month.
    scratch/ hard-coded 2026-11, which is wrong the moment a job runs in another
    month, so the date is recovered from the window instead: the day in the window
    whose weekday and day-of-month match the stamp.
    """
    idx = {}
    d = date.fromtimestamp(start)
    last = date.fromtimestamp(end)
    while d <= last:
        day_ms = time.mktime(d.timetuple()) * 1000
        idx.setdefault(time.strftime('%a %d', time.localtime(day_ms / 1000)), []).append(day_ms)
        d += timedelta(days=1)
    return idx


def epoch_of(ts_str, idx):
    """'Wed 04 15:30' -> epoch ms, or None when no day in the window matches.

    None means the raw file was written by a scan with a different --since, so this
    row cannot be placed in this window; callers count it rather than guess a date.
    """
    parts = ts_str.split(' ')
    if len(parts) < 3:
        return None
    hhmm = parts[2].split(':')
    if len(hhmm) != 2:
        return None
    days = idx.get(' '.join(parts[:2]))
    if not days:
        return None
    day = time.localtime(days[0] / 1000)
    return time.mktime(
        (day.tm_year, day.tm_mon, day.tm_mday, int(hhmm[0]), int(hhmm[1]), 0, -1, -1, -1)
    ) * 1000


def load_versions(sessions, start_epoch):
    """sid -> [(timestamp_ms, forge_version)] from each log's session_start rows.

    version_join.py and tips_repeats.py both ask which Forge version a failure row
    happened on, so the lookup lives here rather than twice. A log whose file
    modification time is before the window start cannot hold a row in the window, so
    it is skipped; sid is the first 8 characters of the log's file name, as in every
    other script here.
    """
    vers = collections.defaultdict(list)
    for path in session_files(sessions):
        if os.path.getmtime(path) < start_epoch:
            continue
        sid = os.path.basename(path)[:8]
        for line in open(path, encoding='utf-8', errors='replace'):
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get('type') == 'session_start':
                vers[sid].append((r.get('timestamp_ms') or 0, r.get('forge_version') or '?'))
    return vers


def version_at(vers, idx, sid, ts_str):
    """The Forge version that was running when this raw row happened.

    The raw stamp carries no year or month, so the row's moment comes from the scan
    window through epoch_of; a row that matches no day in the window answers '?' the
    same way. Otherwise the answer is the last version the session logged at or just
    before that moment (a minute of slack: the version is written when the chat
    starts, the failure arrives later in it).
    """
    e = epoch_of(ts_str, idx)
    if e is None:
        return '?'
    best = '?'
    for ts, v in sorted(vers.get(sid, [])):
        if ts <= e + 60000:
            best = v
    return best


def read_summary(out_dir):
    """The scanner's summary as a dict, or {} when it has not been run yet."""
    summ = {}
    f = Path(out_dir) / OUT_FILES['summary']
    if f.exists():
        for line in f.read_text(encoding='utf-8').splitlines():
            k, _, v = line.partition(' ')
            if v.strip():
                summ[k] = v.strip()
    return summ
