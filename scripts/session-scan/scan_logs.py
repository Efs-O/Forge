"""Scan the session logs for failed tool calls: raw rows, signatures and a summary.

Writes <out>/failed_tools_raw.txt, <out>/failed_tools_sig.txt,
<out>/scan_summary.txt and freezes <out>/scan_cutoff.txt for the other scripts.
Run this first; recovery_check.py and version_join.py read what it wrote.

Shared argument handling is in session_scan_common.py.
"""

import json, os, re, sys, collections, time
from session_scan_common import (
    parse,
    need_sessions,
    session_files,
    window,
    freeze_cutoff,
    exclude_set,
    excluded,
    version_ok,
    is_forge_workspace,
    writer,
)

opts = parse('scan session logs for failed tool calls')
need_sessions(opts.sessions)
CUT_S, CUT_E = window(opts)
CUT = CUT_S * 1000
CUT_E_MS = CUT_E * 1000
PROBE = exclude_set(opts.exclude)

# The scanner is the one that fixes the window end: it reuses a saved value, and
# writes it back so a re-run and the other scripts all read the same moment.
freeze_cutoff(opts.out, CUT_E)


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
    if f.startswith('Error:') or f.startswith('REFUSED') or 'Forge cannot' in f[:200] or 'is refused' in f[:200]:
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


rows = []
counts = collections.Counter()
sigc = collections.Counter()
sigc_outside = collections.Counter()
by_model = collections.Counter()
by_day = collections.Counter()
toolres_total = collections.Counter()
model_calls = collections.Counter()
model_fails_prod = collections.Counter()
toolres_prod = collections.Counter()
by_day_calls = collections.Counter()
by_day_calls_prod = collections.Counter()
by_day_fail_prod = collections.Counter()
tool_fails_all = collections.Counter()
tool_fails_prod = collections.Counter()
forge_rule_all = collections.Counter()
forge_rule_prod = collections.Counter()
chats = set()
outside_rows = 0
files_scanned = 0
recs_scanned = 0

for path in session_files(opts.sessions):
    if os.path.getmtime(path) < CUT_S:
        continue
    files_scanned += 1
    sid = os.path.basename(path)[:8]
    chats.add(sid)
    title = ''
    cur_ver = '?'
    cur_ws = '?'
    calls = {}
    for line in open(path, encoding='utf-8', errors='replace'):
        try:
            r = json.loads(line)
        except Exception:
            continue
        ts = r.get('timestamp_ms') or 0
        if ts < CUT:
            if r.get('type') == 'session_start':
                title = (r.get('title') or '')[:40]
                # Read before the window on purpose: a chat that started on the old
                # build is still on it for every tool row that follows.
                cur_ver = r.get('forge_version') or '?'
                # Same for the workspace: a chat runs in one folder from start to end.
                cur_ws = r.get('workspace_name') or '?'
            continue
        recs_scanned += 1
        t = r.get('type') or r.get('role')
        if t == 'session_start':
            title = (r.get('title') or '')[:40]
            cur_ver = r.get('forge_version') or '?'
            cur_ws = r.get('workspace_name') or '?'
        elif t == 'assistant':
            for c in (r.get('tool_calls') or []):
                if not calls and len(rows) < 1:
                    # Debug probe only: it goes to stderr, never into an output file.
                    # Writing it to the sig file used to eat that file's first line
                    # (the handle stayed open, so its flush landed at position 0 after
                    # the signature block had been written). Found by T4, 2026-11-08.
                    print('PROBE_CALL_KEYS', sorted(c.keys()), file=sys.stderr)
                cid = c.get('id')
                args_json = c.get('arguments') or c.get('args') or c.get('input') or ''
                if not isinstance(args_json, str):
                    args_json = json.dumps(args_json, ensure_ascii=False)
                calls[cid] = (c.get('name') or '', args_json)
        elif t == 'tool':
            if ts > CUT_E_MS:
                # Nothing outside the window is counted, so a re-run cannot quietly
                # move the rates this report calls frozen.
                continue
            if not version_ok(cur_ver, opts.min_version):
                # A row from a build this report is not measuring: skipped whole, so
                # it lands in no total and writes no raw row. The per-tool rate in
                # failed_tools_rate.txt is then the current build's, not a mix.
                continue
            nm = r.get('name') or '?'
            mdl = r.get('model') or '?'
            day = time.strftime('%a %d', time.localtime(ts / 1000))
            toolres_total[nm] += 1
            model_calls[mdl] += 1
            by_day_calls[day] += 1
            if not excluded(sid, PROBE):
                toolres_prod[mdl] += 1
                by_day_calls_prod[day] += 1
            # Forge's own three prefixes only, so a rate comparable with last
            # month's report can be quoted without my extra expressions.
            head0 = txt_of(r.get('content')).split('\n')[0].strip()
            if head0.startswith('Error:') or head0.startswith('User declined:') or head0.startswith('unattended:'):
                forge_rule_all[nm] += 1
                if not excluded(sid, PROBE):
                    forge_rule_prod[nm] += 1
            body = txt_of(r.get('content'))
            first = body.split('\n')[0]
            b = bucket(first)
            if not b:
                continue
            name = r.get('name') or (calls.get(r.get('tool_call_id'), ('', ''))[0]) or '?'
            args_json = calls.get(r.get('tool_call_id'), ('', ''))[1]
            row = dict(
                ts=time.strftime('%a %d %H:%M', time.localtime(ts / 1000)),
                sid=sid,
                title=title,
                model=(r.get('model') or '?')[:40],
                tool=name,
                bucket=b,
                ws=cur_ws,
                args=args_json[:180].replace('\n', ' '),
                err=body[:400].replace('\n', ' | '),
                s=sig(first),
                cid=(r.get('tool_call_id') or '')[:20],
            )
            rows.append(row)
            counts[b] += 1
            sigc[(b, name, row['s'])] += 1
            if not is_forge_workspace(row['ws']):
                # '?' (a log from before `workspace_name` existed) counts as outside.
                outside_rows += 1
                sigc_outside[(b, name, row['s'])] += 1
            by_model[(mdl, b)] += 1
            by_day[day] += 1
            tool_fails_all[name] += 1
            if not excluded(sid, PROBE):
                tool_fails_prod[name] += 1
                by_day_fail_prod[day] += 1
                model_fails_prod[mdl] += 1

rows.sort(key=lambda x: (int(x['ts'].split()[1]), x['ts'].split()[2]))
# Ten tab columns, `workspace` right after the chat id and the call id still last:
# args and err are not tab-escaped, so tips_repeats.py reads them as `p[7]` and
# `p[8:-1]` and any column added after the call id would swallow one of them.
with writer(opts.out, 'raw') as f:
    for r in rows:
        f.write('\t'.join([r['ts'], r['bucket'], r['tool'], r['model'], r['sid'], r['ws'],
                          r['title'], 'ARGS: ' + r['args'], 'ERR: ' + r['err'], r['cid']]) + '\n')

# Per-tool failure rate. The job asks which tool fails more than a third of its
# calls, and nothing else here wrote calls per tool, so the question could not be
# answered. 'calls' is every tool result counted above (already window- and
# version-filtered); 'failures' is the raw rows just written, keyed by the same
# name the raw file shows. The tools worth reading come first: 10 calls or more,
# worst rate on top, ties broken by name; the rare ones follow in the same order.
fails_by_tool = collections.Counter()
for r in rows:
    fails_by_tool[r['tool']] += 1
rate_rows = []
for nm in set(toolres_total) | set(fails_by_tool):
    calls_n = toolres_total[nm]
    fails_n = fails_by_tool[nm]
    rate_rows.append((nm, calls_n, fails_n, fails_n * 100.0 / calls_n if calls_n else 0.0))
rate_rows.sort(key=lambda x: (0 if x[1] >= 10 else 1, -x[3], x[0]))
with writer(opts.out, 'rate') as rf:
    rf.write('tool\tcalls\tfailures\trate%\n')
    for nm, calls_n, fails_n, rate in rate_rows:
        rf.write('%s\t%d\t%d\t%.1f\n' % (nm, calls_n, fails_n, rate))

with writer(opts.out, 'summary') as sf:
    sf.write('CUTOFF %s\n' % time.strftime('%Y-%m-%d %H:%M', time.localtime(CUT_E)))
    # The two facts that make the numbers reproducible: where this window began
    # (so the next run can start where this one ended) and which builds counted.
    sf.write('WINDOW_START %s\n' % CUT_S)
    sf.write('MIN_VERSION %s\n' % (opts.min_version or 'none'))
    sf.write('CHATS %d\n' % len(chats))
    sf.write('TOOL_RESULTS %d\n' % sum(toolres_total.values()))
    sf.write('TOOL_RESULTS_PROD %d\n' % sum(toolres_prod.values()))
    sf.write('FORGE_RULE_FAIL_ALL %d\n' % sum(forge_rule_all.values()))
    sf.write('FORGE_RULE_FAIL_PROD %d\n' % sum(forge_rule_prod.values()))
    sf.write('BUCKETS %s\n' % json.dumps(dict(counts)))
    sf.write('BY_DAY_FAIL_PROD %s\n' % json.dumps(dict(by_day_fail_prod)))
    sf.write('BY_TOOL_ALL %s\n' % json.dumps(tool_fails_all.most_common()))
    sf.write('BY_TOOL_PROD %s\n' % json.dumps(tool_fails_prod.most_common()))
    sf.write('MODEL %s\n' % json.dumps({m: [toolres_prod.get(m, 0), model_fails_prod.get(m, 0)]
                                        for m in set(toolres_prod) | set(model_fails_prod)}))


def a(s):
    return s.encode('ascii', 'replace').decode('ascii')


print('FILES_SCANNED', files_scanned, 'RECORDS_AFTER_CUT', recs_scanned, 'FAILURES', len(rows))
print('OUTSIDE_ROWS', outside_rows, '(chat workspace is not Forge)')
print('BUCKETS:', dict(counts))
print('DAYS:', dict(sorted(by_day.items(), key=lambda kv: int(kv[0].split()[1]))))
print('PROD_FAIL_BY_DAY:', dict(sorted(by_day_fail_prod.items(), key=lambda kv: int(kv[0].split()[1]))))
print('FORGE_RULE_ALL', sum(forge_rule_all.values()), 'FORGE_RULE_PROD', sum(forge_rule_prod.values()))
print('TOP_TOOL_RESULTS:', toolres_total.most_common(12))
print('BY_MODEL:', by_model.most_common(15))
print('--- SIGNATURES ---')
with writer(opts.out, 'sig') as f:
    for (b, name, s), c in sigc.most_common(200):
        f.write('%4d  %-14s %-16s %s\n' % (c, b, name, s))
        if c >= 2:
            print('%4d %-14s %-14s %s' % (c, a(b), a(name), a(s)))
# The same signatures, counted only for chats whose workspace is not Forge: subject
# knowledge (Blender, ffmpeg, an engine) lands in whichever repo hit it first and
# never reaches the others, so the report needs to say whose it was. A run with no
# such rows writes an empty file.
with writer(opts.out, 'sig_outside') as f:
    for (b, name, s), c in sigc_outside.most_common(200):
        f.write('%4d  %-14s %-16s %s\n' % (c, b, name, s))
print('--- SINGLETONS (count 1) ---')
for (b, name, s), c in sigc.items():
    if c == 1:
        print('   1 %-14s %-14s %s' % (a(b), a(name), a(s)))
