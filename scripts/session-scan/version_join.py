"""Which Forge version each failure row happened on, from the scanner's raw rows.

Reads <out>/failed_tools_raw.txt written by scan_logs.py plus the session logs
themselves (for the forge_version on each session_start); writes
<out>/failed_tools_versions.txt. Run scan_logs.py first, with the same
--sessions, --out and --since.

Shared argument handling is in session_scan_common.py.
"""

import collections, sys
from session_scan_common import (
    REPO_ROOT,
    OUT_FILES,
    parse,
    need_sessions,
    window,
    writer,
    day_index,
    load_versions,
    version_at,
)

opts = parse('join failure rows to the Forge version they happened on')
need_sessions(opts.sessions)
CUT_S, CUT_E = window(opts)

RAW = opts.out / OUT_FILES['raw']
if not RAW.exists():
    sys.exit(f'{RAW} is missing; run scan_logs.py with the same --out first')

# sid -> list of (ts, forge_version) from session_start records; built in
# session_scan_common.py so tips_repeats.py asks the same question of the same dict.
vers = load_versions(opts.sessions, CUT_S)

# The raw stamp carries no year or month, so the date is recovered from the scan
# window instead of being hard-coded to one month.
IDX = day_index(CUT_S, CUT_E)


def cls(err):
    e = err.lower()
    if 'refuses to change forge' in e or "part of forge's own files" in e:
        return 'owner_only_guard'
    if 'cd ' in e and 'read-only table does not class' in e:
        return 'cd_then_write_refusal'
    if 'eperm' in e:
        return 'atomic_rename_eperm'
    if 'old_str not found' in e:
        return 'edit_text_mismatch'
    if 'expected_lines' in e:
        return 'edit_line_stale'
    if 'timeout_ms must' in e:
        return 'arg_out_of_range'
    if 'has unknown' in e:
        return 'arg_unknown_key'
    if 'missing required' in e or 'is missing' in e:
        return 'arg_missing'
    if 'invalid json' in e:
        return 'arg_bad_json'
    if 'did not declare' in e:
        return 'arg_extra_field'
    if 'the limit is' in e:
        return 'arg_too_long'
    if 'unknown tool' in e:
        return 'tool_name_wrong'
    if 'vision' in e:
        return 'vision_gate'
    if 'outside the workspace' in e or 'outside extra_file_roots' in e:
        return 'path_outside_workspace'
    if 'http ' in e or 'search:' in e or 'api key' in e:
        return 'network_or_key'
    if 'nothing exists' in e or 'does not exist' in e:
        return 'path_missing'
    if 'declined' in e:
        return 'user_declined'
    return 'other'


rows = []
for line in open(RAW, encoding='utf-8'):
    p = line.rstrip('\n').split('\t', 8)
    if len(p) < 9:
        continue
    rows.append(dict(ts=p[0], bucket=p[1], tool=p[2], model=p[3], sid=p[4], err=p[8][5:]))

tab = collections.Counter()
ver_all = collections.Counter()
by_class_ver = collections.defaultdict(collections.Counter)
for r in rows:
    if r['bucket'] == 'SHELL_NONZERO':
        continue
    v = version_at(vers, IDX, r['sid'], r['ts'])
    c = cls(r['err'])
    tab[(c, v)] += 1
    by_class_ver[c][v] += 1
    ver_all[v] += 1

with writer(opts.out, 'versions') as out:
    out.write('FORGE VERSIONS SEEN IN FAILURE ROWS: %s\n\n' % dict(ver_all.most_common()))
    out.write('CLASS x VERSION (tool-layer failures only, %d rows):\n' % sum(ver_all.values()))
    for c in sorted(by_class_ver, key=lambda k: -sum(by_class_ver[k].values())):
        out.write('  %-24s %s\n' % (c, dict(by_class_ver[c].most_common())))
    out.write('\nPER SESSION VERSION AND FAILURE COUNT:\n')
    per = collections.Counter()
    perc = collections.defaultdict(collections.Counter)
    for r in rows:
        v = version_at(vers, IDX, r['sid'], r['ts'])
        per[(r['sid'], v)] += 1
        perc[(r['sid'], v)][cls(r['err'])] += 1
    for (sid, v), c in per.most_common():
        out.write('  %s %-10s %3d  %s\n' % (sid, v, c, dict(perc[(sid, v)].most_common(6))))

print('VERSIONS', dict(ver_all.most_common()))
pkg = REPO_ROOT / 'package.json'
try:
    print('CURRENT_PKG', pkg.read_text(encoding='utf-8').split('"version":')[1].split('\n')[0][:12])
except Exception as e:
    print('CURRENT_PKG unknown:', e)
