"""Compare tool failure rates before and after Fix-level commits."""

import argparse
import csv
import re
import statistics
import subprocess
from datetime import date, datetime, timedelta
from pathlib import Path


FIX_LINE = re.compile(r'^Fix-level:\s*(.+?)\s*$', re.MULTILINE)
HISTORY_DATE = '%Y-%m-%d %H:%M'


def git_commits(repo, since):
    fmt = '%H%x00%cs%x00%s%x00%b%x1e'
    result = subprocess.run(
        ['git', '-C', str(repo), 'log', f'--since={since}', f'--format={fmt}'],
        check=True, capture_output=True, text=True, encoding='utf-8', errors='replace',
    )
    commits = []
    for record in result.stdout.split('\x1e'):
        fields = record.strip('\n').split('\x00', 3)
        if len(fields) != 4:
            continue
        sha, day, subject, body = fields
        levels = [line.strip() for line in FIX_LINE.findall(body)]
        if levels:
            commits.append({
                'sha': sha,
                'date': date.fromisoformat(day),
                'subject': subject,
                'body': body,
                'levels': levels,
            })
    return commits


def read_history(path):
    rows = []
    with path.open(encoding='utf-8', newline='') as stream:
        for row in csv.DictReader(stream, delimiter='\t'):
            rows.append({
                **row,
                'start_dt': datetime.strptime(row['window_start'], HISTORY_DATE),
                'cutoff_dt': datetime.strptime(row['cutoff'], HISTORY_DATE),
                'calls_n': int(row['calls']),
                'fails_n': int(row['failures']),
                'rate_n': float(row['rate%']),
            })
    return rows


def tool_mentions(commit, tools):
    text = commit['subject'] + '\n' + commit['body']
    return [tool for tool in tools if re.search(r'(?<!\w)' + re.escape(tool) + r'(?!\w)', text)]


def rate_text(row):
    return f"{row['calls_n']}/{row['fails_n']}/{row['rate_n']:.1f}%"


def compare(history, tool, commit_day):
    before = [r for r in history if r['tool'] == tool and r['cutoff_dt'].date() < commit_day]
    after_day = commit_day + timedelta(days=1)
    after = [r for r in history if r['tool'] == tool and r['start_dt'].date() >= after_day]
    prior = max(before, key=lambda row: row['cutoff_dt']) if before else None
    next_row = min(after, key=lambda row: row['start_dt']) if after else None
    return prior, next_row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--history', type=Path, required=True, help='rate history TSV')
    parser.add_argument('--since', required=True, metavar='YYYY-MM-DD', help='git log start date')
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[2],
                        help='git repository (default: this script\'s repository)')
    args = parser.parse_args()
    try:
        date.fromisoformat(args.since)
    except ValueError:
        raise SystemExit('--since must be YYYY-MM-DD')

    history = read_history(args.history)
    tools = sorted({row['tool'] for row in history})
    commits = git_commits(args.repo.resolve(), args.since)
    output = args.history.with_name('fix_levels.txt')
    by_level = {}
    no_tool = []
    lines = []

    for commit in commits:
        mentioned = tool_mentions(commit, tools)
        if not mentioned:
            no_tool.append(commit)
        lines.append(
            f"COMMIT {commit['date']} {commit['sha']} {commit['subject']} | "
            f"Fix-level: {', '.join(commit['levels'])}"
        )
        for level in commit['levels']:
            stats = by_level.setdefault(level, {
                'commits': set(), 'no_tool': set(), 'paired': 0,
                'dropped': 0, 'rose': 0, 'same': 0, 'changes': [],
            })
            stats['commits'].add(commit['sha'])
            if not mentioned:
                stats['no_tool'].add(commit['sha'])
        for tool in mentioned:
            before, after = compare(history, tool, commit['date'])
            if before and after:
                change = after['rate_n'] - before['rate_n']
                result = 'dropped' if change < 0 else ('rose' if change > 0 else 'same')
                for level in commit['levels']:
                    stats = by_level[level]
                    stats['paired'] += 1
                    stats[result] += 1
                    stats['changes'].append(change)
                change_text = f'{change:+.1f}pp ({result})'
            else:
                change_text = 'no window'
            before_text = rate_text(before) if before else 'no window'
            after_text = rate_text(after) if after else 'no window'
            lines.append(
                f"  TOOL {tool} | before {before_text} | after {after_text} | change {change_text}"
            )

    if no_tool:
        lines.extend(['# no tool named'] + [
            f"{commit['date']} {commit['sha']} {commit['subject']} | "
            f"Fix-level: {', '.join(commit['levels'])}"
            for commit in no_tool
        ])
    lines.append('SUMMARY')
    for level in sorted(by_level):
        stats = by_level[level]
        median = statistics.median(stats['changes']) if stats['changes'] else None
        median_text = f'{median:+.1f}' if median is not None else 'no data'
        lines.append(
            f"LEVEL {level} | commits {len(stats['commits'])} | no_tool {len(stats['no_tool'])} | "
            f"paired {stats['paired']} | dropped {stats['dropped']} | rose {stats['rose']} | "
            f"same {stats['same']} | median_change_pp {median_text}"
        )
    output.write_text('\n'.join(lines) + '\n', encoding='utf-8', newline='\n')
    print(f'WROTE {output} ({len(commits)} commits, {len(no_tool)} without a named tool)')
    print('\n'.join(line for line in lines if line == 'SUMMARY' or line.startswith('LEVEL ')))


if __name__ == '__main__':
    main()
