"""Which tip rows are still being repeated, from the scanner's raw rows.

A tip row only helps if the mistake it describes stops happening. This counts, for
every numbered row of docs/CODING_TIPS.md and resources/tips/CODING_TIPS.md, the
failed tool calls that are that same mistake made AFTER the row was written. A row
with repeats is a tip that is not enough: the tool itself should refuse the wrong
call or name the right one in its description, and then the row gets deleted.

It reads both tips tables, the git history that first added each row (to date it),
<out>/failed_tools_raw.txt written by scan_logs.py, and the session logs (for the
Forge version under each repeat); it writes <out>/tips_repeats.txt. Run scan_logs.py
first, with the same --sessions, --out and --since.

Shared argument handling is in session_scan_common.py.
"""

import re
import subprocess
import sys
import time
from collections import Counter
from datetime import date, timedelta
from session_scan_common import (
    REPO_ROOT,
    OUT_FILES,
    parse,
    need_sessions,
    window,
    exclude_set,
    excluded,
    writer,
    day_index,
    epoch_of,
    load_versions,
    version_at,
)

opts = parse('count failed calls that repeat a mistake already written as a tip row')
need_sessions(opts.sessions)
CUT_S, CUT_E = window(opts)

RAW = opts.out / OUT_FILES['raw']
if not RAW.exists():
    sys.exit(f'{RAW} is missing; run scan_logs.py with the same --out first')

# The two tips tables, in the order the extension injects them. A missing table
# contributes no rows: this repo's project list is machine-local, and a user's
# workspace may have none at all.
TIPS_TABLES = (
    ('project', 'docs/CODING_TIPS.md'),
    ('shipped', 'resources/tips/CODING_TIPS.md'),
)
# A call the owner declined, or one an unattended run refused to ask for, is not
# the model making the mistake, so neither counts as a repeat.
SKIP_BUCKETS = {'USER_DECLINED', 'UNATTENDED_DENIED'}
ARROW = '→'
ROW_RE = re.compile(r'^(\d+)\.\s+(.*)$')
SECTION_RE = re.compile(r'^## (\S+)')
TOOL_RE = re.compile(r'^`([^`]+)`\s*·\s*(.*)$')
SPAN_RE = re.compile(r'`([^`]*)`|"([^"]*)"')
PLACEHOLDER_RE = re.compile(r'\.\.\.|…|<|\bN\b')
ARG_SPAN_RE = re.compile(r'`([^`]*)`')
ARG_KEY_RE = re.compile(r'^([A-Za-z_]\w*)\s*:')
STRIP = ' .,:;('


def tip_rows():
    """Every numbered row of both tables, in file order, as (id, tool, text).

    A row is a line of the form '12. <body>' under a '## NAME' heading, and its id
    is '<table>:<SECTION> <n>' so a report line reads back to the exact row. Under
    ## FORGE_TOOLS a row opens with the tool it is about — '`tool` · <text>' — and
    that tool is what the failed calls are matched on; every other section is about
    a mistake that is not one tool's fault, so its tool is None and any tool counts.
    """
    rows = []
    for short, rel in TIPS_TABLES:
        f = REPO_ROOT / rel
        if not f.exists():
            continue
        section = 'NONE'
        for line in f.read_text(encoding='utf-8').splitlines():
            head = SECTION_RE.match(line)
            if head:
                section = head.group(1)
                continue
            m = ROW_RE.match(line)
            if not m:
                continue
            n, body = int(m.group(1)), m.group(2)
            tool, text = None, body
            if section == 'FORGE_TOOLS':
                tm = TOOL_RE.match(body)
                if tm:
                    tool, text = tm.group(1), tm.group(2)
            rows.append(dict(id='%s:%s %d' % (short, section, n), tool=tool, text=text))
    return rows


def error_words(after):
    """The error text the row quotes, or None when it quotes nothing usable.

    The first quoted span in the text after the arrow is what the tool answered —
    back-ticked or in double quotes, whichever starts first. It is cut where the row
    abbreviates it ('...', '…', '<' or an 'N' placeholder) and stripped of the
    punctuation left around it; under 8 characters what is left is not enough to
    match on, so the row cannot be measured by its error text. A span that opens
    with a brace or a bracket is a code sample rather than an answer — a refusal
    never starts that way — so it is not error text either, and the row falls to the
    argument it names instead (which is what a '`path:`' row is really about).
    """
    m = SPAN_RE.search(after)
    if not m:
        return None
    span = m.group(1) if m.group(1) is not None else m.group(2)
    span = PLACEHOLDER_RE.split(span)[0].strip(STRIP)
    if len(span) < 8 or span[0] in '{[':
        return None
    return span


def argument_span(before):
    """(span, key) for the argument the row names before the arrow, or (None, None).

    The first back-ticked span written 'name:' — '`path:`' gives the key 'path'.
    Only a row about one tool can be matched this way: it is the failed call's own
    arguments that are checked for "path" and the like.
    """
    for m in ARG_SPAN_RE.finditer(before):
        k = ARG_KEY_RE.match(m.group(1))
        if k:
            return m.group(1), k.group(1)
    return None, None


def tip_date(needle):
    """The first commit that added this text to either tips table, or 'undated'.

    git log -S reports commits that change the number of occurrences, so with
    --reverse the first line is the commit that introduced the words — wherever the
    row lives now. Both tables exist through the whole history, so a row moved
    between them keeps its original date; a rewrite that reworded the row is what
    makes it undated, and the report says so instead of guessing.
    """
    try:
        done = subprocess.run(
            ['git', 'log', '--reverse', '--format=%ad', '--date=short', '-S' + needle,
             '--', 'docs/CODING_TIPS.md', 'resources/tips/CODING_TIPS.md'],
            cwd=str(REPO_ROOT), capture_output=True, text=True, encoding='utf-8', check=True)
    except Exception:
        return 'undated'
    for line in done.stdout.splitlines():
        if line.strip():
            return line.strip()
    return 'undated'


def measure(row):
    """Decide how this row can be matched, and from which date.

    Adds 'reason' (not measurable) or 'words'/'key' plus its 'date' to the row.
    """
    text = row['text']
    if ARROW not in text:
        row['reason'] = 'no arrow'
        return row
    before, after = text.split(ARROW, 1)
    words = error_words(after)
    key = None
    if words is None and row['tool'] is not None:
        span, key = argument_span(before)
        if key:
            row['date'] = tip_date('`' + span + '`')
    if words is None and key is None:
        row['reason'] = 'no error or argument words'
        return row
    if words is not None:
        row['date'] = tip_date(words)
    row['words'] = words
    row['key'] = key
    return row


def first_day_after(date_str):
    """Local midnight of the day after the row's date, in ms; the window start when undated."""
    try:
        day = date.fromisoformat(date_str) + timedelta(days=1)
        return time.mktime(day.timetuple()) * 1000
    except ValueError:
        return CUT_S * 1000


IDX = day_index(CUT_S, CUT_E)
VERS = load_versions(opts.sessions, CUT_S)
PROBE = exclude_set(opts.exclude)

# The failed calls to match against: one row per failed call the scanner wrote,
# minus the declined ones and the probe chats, and minus the rows this window
# cannot place — a raw stamp matches no day in the window when the raw file was
# written with a different --since, and guessing a date for it would double-count.
fails = []
unplaced = 0
for line in open(RAW, encoding='utf-8'):
    p = line.rstrip('\n').split('\t')
    if len(p) < 9:
        continue
    if p[1] in SKIP_BUCKETS or excluded(p[4], PROBE):
        continue
    e = epoch_of(p[0], IDX)
    if e is None:
        unplaced += 1
        continue
    fails.append(dict(e=e, ts=p[0], tool=p[2], model=p[3], sid=p[4],
                      args=p[6], err_l='\t'.join(p[7:-1]).lower()))

measured = [measure(r) for r in tip_rows()]
measurable = [r for r in measured if 'reason' not in r]
for t in measurable:
    t['start'] = first_day_after(t['date'])
    t['err_l'] = t['words'].lower() if t['words'] else None
    t['needle'] = '"%s"' % t['key'] if t['key'] else None
    t['reps'] = 0
    t['chats'] = set()
    t['vers'] = Counter()
    t['models'] = Counter()

for t in measurable:
    for f in fails:
        if t['tool'] is not None and t['tool'] != f['tool']:
            continue
        if f['e'] < t['start']:
            continue
        if t['err_l'] is not None:
            if t['err_l'] not in f['err_l']:
                continue
        elif t['needle'] not in f['args']:
            continue
        t['reps'] += 1
        t['chats'].add(f['sid'])
        t['vers'][version_at(VERS, IDX, f['sid'], f['ts'])] += 1
        t['models'][f['model']] += 1


def top(counter):
    """The three most common values as 'value×count', most common first."""
    return ', '.join('%s×%d' % (v, n) for v, n in counter.most_common(3)) or '-'


def one(text):
    """First 100 characters of the tip, on one line."""
    return text[:100].replace('\t', ' ')


OUT = opts.out / OUT_FILES['repeats']
with writer(opts.out, 'repeats') as out:
    out.write('# tips_repeats run %s window %s..%s unplaced %d\n' % (
        time.strftime('%Y-%m-%d %H:%M'),
        time.strftime('%Y-%m-%d', time.localtime(CUT_S)),
        time.strftime('%Y-%m-%d %H:%M', time.localtime(CUT_E)),
        unplaced))
    out.write('# repeats\tchats\tdate\tid\ttool\tmatch\tversions\tmodels\ttip\n')
    for t in sorted(measurable, key=lambda r: (-r['reps'], r['id'])):
        match = ('err:' + t['words']) if t['words'] else ('arg:' + t['key'])
        out.write('%d\t%d\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' % (
            t['reps'], len(t['chats']), t['date'], t['id'], t['tool'] or '*', match,
            top(t['vers']), top(t['models']), one(t['text'])))
    out.write('# not measurable\n')
    for r in measured:
        if 'reason' in r:
            out.write('%s\t%s\t%s\n' % (r['id'], r['reason'], one(r['text'])))

print('WROTE', OUT)
print('MEASURABLE_TIPS', len(measurable), 'NOT_MEASURABLE', len(measured) - len(measurable))
