"""Append per-window tool rates to a durable, idempotent TSV history."""

import argparse
import csv
import time
from datetime import datetime
from pathlib import Path


HEADER = [
    'window_start', 'cutoff', 'min_version', 'tool', 'calls', 'failures', 'rate%',
]


def read_summary(folder):
    values = {}
    path = Path(folder) / 'scan_summary.txt'
    if not path.is_file():
        return values
    for line in path.read_text(encoding='utf-8').splitlines():
        key, _, value = line.partition(' ')
        if value.strip():
            values[key] = value.strip()
    return values


def local_minute(value, epoch=False):
    if epoch:
        return time.strftime('%Y-%m-%d %H:%M', time.localtime(float(value)))
    return datetime.strptime(value, '%Y-%m-%d %H:%M').strftime('%Y-%m-%d %H:%M')


def folder_record(folder):
    summary = read_summary(folder)
    if 'MIN_VERSION' not in summary:
        print(f'SKIP {folder}: no MIN_VERSION')
        return None
    try:
        cutoff = local_minute(summary['CUTOFF'])
        start = local_minute(summary['WINDOW_START'], epoch=True)
        cutoff_order = datetime.strptime(cutoff, '%Y-%m-%d %H:%M')
    except (KeyError, ValueError):
        raise SystemExit(f'{folder}: scan_summary.txt has invalid CUTOFF or WINDOW_START')
    rate_path = Path(folder) / 'failed_tools_rate.txt'
    if not rate_path.is_file():
        raise SystemExit(f'{folder}: missing failed_tools_rate.txt')
    with rate_path.open(encoding='utf-8', newline='') as stream:
        rows = list(csv.DictReader(stream, delimiter='\t'))
    return cutoff_order, start, cutoff, summary['MIN_VERSION'], rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, action='append', required=True,
                        help='scan output folder; repeat to backfill several windows')
    parser.add_argument('--history', type=Path, required=True, help='durable TSV file')
    args = parser.parse_args()

    records = [r for folder in args.out if (r := folder_record(folder)) is not None]
    records.sort(key=lambda record: record[0])
    history = args.history
    history.parent.mkdir(parents=True, exist_ok=True)
    is_new = not history.exists()
    seen_cutoffs = set()
    if not is_new:
        with history.open(encoding='utf-8', newline='') as stream:
            for row in csv.DictReader(stream, delimiter='\t'):
                if row.get('cutoff'):
                    seen_cutoffs.add(row['cutoff'])
    with history.open('a', encoding='utf-8', newline='') as stream:
        writer = csv.writer(stream, delimiter='\t', lineterminator='\n')
        if is_new or history.stat().st_size == 0:
            writer.writerow(HEADER)
        for _, start, cutoff, min_version, rows in records:
            if cutoff in seen_cutoffs:
                print(f'ALREADY {cutoff}')
                continue
            for row in rows:
                writer.writerow([
                    start, cutoff, min_version, row['tool'], row['calls'],
                    row['failures'], row['rate%'],
                ])
            seen_cutoffs.add(cutoff)
            print(f'APPENDED {cutoff} ({len(rows)} tools)')


if __name__ == '__main__':
    main()
