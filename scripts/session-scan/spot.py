"""Up to three full examples of each recurring tool-call error.

Reads the session logs; writes <out>/failed_tools_spot.txt. Takes --sessions,
--out, --since, --since-cutoff, --min-version and --exclude like the others;
--exclude is unused here, since this script quotes examples rather than counting
them.

Shared argument handling is in session_scan_common.py.
"""

import json, collections, os, time
from session_scan_common import (
    parse,
    need_sessions,
    session_files,
    start_epoch,
    version_ok,
    writer,
)

opts = parse('collect example failures for each recurring tool error')
need_sessions(opts.sessions)
CUT_S = start_epoch(opts.since, opts.since_cutoff)
KEYS = {
    'EPERM': 'EPERM',
    'timeout_ms must': 'TIMEOUT_LIMIT',
    'has unknown': 'READS_ITEM_KEY',
    'refuses to change Forge': 'OWN_FILES_REFUSAL',
    'no vision projector': 'VISION',
    'the limit is': 'CHAR_LIMIT',
    'unknown tool': 'UNKNOWN_TOOL',
    'outside the workspace': 'OUTSIDE_WS',
    'is stale': 'STALE_LINES',
    'missing required': 'MISSING_ARG',
    'invalid JSON': 'BAD_JSON',
    'did not declare': 'EXTRA_FIELD',
    'not found in file': 'OLD_STR_MISS',
    'HTTP 4': 'HTTP_4xx',
}
CAPS = collections.defaultdict(list)
seen = collections.Counter()

for path in session_files(opts.sessions):
    if os.path.getmtime(path) < CUT_S:
        continue
    sid = os.path.basename(path)[:8]
    calls = {}
    title = ''
    cur_ver = '?'
    for line in open(path, encoding='utf-8', errors='replace'):
        try:
            r = json.loads(line)
        except Exception:
            continue
        ts = r.get('timestamp_ms') or 0
        if ts < CUT_S * 1000:
            if (r.get('type') or '') == 'session_start':
                title = (r.get('title') or '')[:38]
                # Read before the window on purpose, as in scan_logs.py: a chat that
                # started on an old build is still on it for the rows that follow.
                cur_ver = r.get('forge_version') or '?'
            continue
        t = r.get('type') or r.get('role')
        if t == 'session_start':
            title = (r.get('title') or '')[:38]
            cur_ver = r.get('forge_version') or '?'
            continue
        if t == 'assistant':
            for c in (r.get('tool_calls') or []):
                a = c.get('input') or c.get('arguments') or ''
                if not isinstance(a, str):
                    a = json.dumps(a, ensure_ascii=False)
                calls[c.get('id')] = (c.get('name') or '', a)
            continue
        if t != 'tool':
            continue
        if not version_ok(cur_ver, opts.min_version):
            # An example from a build this report is not measuring; the same filter
            # scan_logs.py applies, so the two files can be read side by side.
            continue
        body = r.get('content')
        if isinstance(body, list):
            body = '\n'.join(str(b.get('text') if isinstance(b, dict) else b) for b in body)
        body = str(body)
        for k, label in KEYS.items():
            if k in body[:300]:
                seen[label] += 1
                if len(CAPS[label]) < 3:
                    nm, args = calls.get(r.get('tool_call_id'), ('?', ''))
                    CAPS[label].append((time.strftime('%a %d %H:%M', time.localtime(ts / 1000)),
                                        sid, title, (r.get('model') or '?'), nm or '?',
                                        args[:900].replace('\n', '\\n'), body[:700].replace('\n', ' | ')))

with writer(opts.out, 'spot') as out:
    for label in sorted(CAPS):
        out.write('==== %s  total %d ====\n' % (label, seen[label]))
        for row in CAPS[label]:
            out.write(' ts=%s sid=%s model=%s tool=%s title=%s\n' % (row[0], row[1], row[3], row[4], row[2]))
            out.write('   ARGS %s\n' % row[5])
            out.write('   ERR  %s\n' % row[6])
print('SEEN', dict(seen))
