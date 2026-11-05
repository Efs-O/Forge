"""How often a failed tool call was retried and worked, from the scanner's raw rows.

Reads <out>/failed_tools_raw.txt, <out>/scan_summary.txt and the frozen
<out>/scan_cutoff.txt written by scan_logs.py; writes <out>/recovery.txt.
Run scan_logs.py first, with the same --sessions, --out and --since.

Shared argument handling is in session_scan_common.py.
"""

import json, os, collections, re, sys
from pathlib import Path
from session_scan_common import (
    parse,
    need_sessions,
    session_files,
    window,
    exclude_set,
    excluded,
    read_summary,
    writer,
    day_index,
    epoch_of,
    OUT_FILES,
)

opts = parse('count whether a failed tool call was retried and worked')
need_sessions(opts.sessions)
CUT_S, CUT_E = window(opts)
CUT_E_MS = CUT_E * 1000
PROBE = exclude_set(opts.exclude)

RAW = opts.out / OUT_FILES['raw']
if not RAW.exists():
    sys.exit(f'{RAW} is missing; run scan_logs.py with the same --out first')

summ = read_summary(opts.out)


def txt(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return '\n'.join(str(b.get('text') if isinstance(b, dict) else b) for b in c)
    return str(c)


def fails(text):
    """Forge's own rule plus the command-exit rule, same as the scanner."""
    f = text.strip().split('\n')[0]
    if f.startswith('User declined') or f.startswith('Denied') or 'declined:' in f[:40].lower():
        return 'declined'
    if (f.startswith('Error:') or f.startswith('unattended:') or f.startswith('REFUSED')
            or 'Forge cannot' in f[:200] or 'is refused' in f[:200]):
        return 'error'
    m = re.match(r'exit (\d+)', f)
    if m and int(m.group(1)) > 0:
        return 'nonzero'
    if re.match(r'^(Tool .*failed|Failed)', f):
        return 'error'
    return None


seq = collections.defaultdict(list)   # sid -> [(epoch, tool, status)]
for path in session_files(opts.sessions):
    if os.path.getmtime(path) < CUT_S:
        continue
    sid = os.path.basename(path)[:8]
    for line in open(path, encoding='utf-8', errors='replace'):
        try:
            r = json.loads(line)
        except Exception:
            continue
        ts = r.get('timestamp_ms') or 0
        if ts < CUT_S * 1000 or ts > CUT_E_MS:
            continue
        if (r.get('type') or r.get('role')) != 'tool':
            continue
        seq[sid].append((ts, r.get('name') or '?', fails(txt(r.get('content')))))

# Two bugs fixed on 5 November after review: the old parser dropped the month, so every
# failure landed in January and any call later in the file counted as a recovery; and it
# threw away attempts inside the failure's own minute. The log stamps only to the minute, so
# a success in the same minute cannot be ordered against the failure and is counted apart.
# The month is now taken from the scan window rather than hard-coded, so a job that runs
# in another month cannot put every failure in November.
IDX = day_index(CUT_S, CUT_E)

recovered = not_retried = ambiguous = unknown = no_date = total = 0
for line in open(RAW, encoding='utf-8'):
    p = line.rstrip('\n').split('\t')
    if len(p) < 8:
        continue
    sid, ts_str, tool, bucket = p[4], p[0], p[2], p[1]
    if excluded(sid, PROBE) or bucket == 'SHELL_NONZERO':
        continue
    total += 1
    e = epoch_of(ts_str, IDX)
    if e is None:
        # The raw file was written by a scan with a different --since, so this row
        # is outside this window; counting it would place it on a guessed date.
        no_date += 1
        continue
    minute = int(e // 60000)
    later = [x for x in seq.get(sid, []) if int(x[0] // 60000) > minute and x[1] == tool]
    same_ok = any(int(x[0] // 60000) == minute and x[1] == tool and x[2] is None
                  for x in seq.get(sid, []))
    if any(x[2] is None for x in later):
        recovered += 1
    elif any(x[2] is not None for x in later):
        not_retried += 1
    elif same_ok:
        ambiguous += 1
    else:
        unknown += 1

with writer(opts.out, 'recovery') as out:
    out.write('CUTOFF %s\n' % summ.get('CUTOFF', '?'))
    out.write('TOTAL %d\n' % total)
    out.write('RECOVERED %d\n' % recovered)
    out.write('NOT_RETRIED %d\n' % not_retried)
    out.write('AMBIGUOUS_SAME_MINUTE %d\n' % ambiguous)
    out.write('NO_LATER_CALL %d\n' % unknown)
    out.write('NO_DATE_MATCH %d\n' % no_date)

day_prod = json.loads(summ.get('BY_DAY_FAIL_PROD', '{}'))
print('CUTOFF', summ.get('CUTOFF', '?'))
print('PROD_FAILURES_BY_DAY', dict(sorted(day_prod.items(), key=lambda kv: int(kv[0].split()[1]))),
      'SUM', sum(day_prod.values()))
print('PROD_TOOL_CALLS', summ.get('TOOL_RESULTS_PROD', '?'), 'ALL', summ.get('TOOL_RESULTS', '?'),
      'CHATS', summ.get('CHATS', '?'))
print('FORGE_RULE_ONLY', summ.get('FORGE_RULE_FAIL_ALL', '?'), 'PROD', summ.get('FORGE_RULE_FAIL_PROD', '?'))
print('BY_TOOL_PROD', json.loads(summ.get('BY_TOOL_PROD', '[]')))
print('MODEL_RATES (prod fails / that model PROD calls, same rows):')
for m, (c, f) in sorted(json.loads(summ.get('MODEL', '{}')).items(), key=lambda kv: -kv[1][0]):
    print('   %-34s %3d of %5d = %.1f%%' % (m[:34], f, c, 100 * f / c if c else 0))
print('RECOVERY same tool later in same chat:', recovered, 'of', total,
      '| retried and failed again', not_retried, '| same-minute only', ambiguous,
      '| no later call', unknown, '| outside this window', no_date)
