"""Find repeated, empty, and recovery detours in tool-call sequences.

Writes <out>/struggle_patterns.txt. Run after scan_logs.py so its frozen cutoff
is reused. This report detects wasted tool calls, not incorrect answers that no
later call questions.
"""

import collections
import json
import os
import re
import time
from pathlib import Path

from session_scan_common import (
    OUT_FILES,
    bucket,
    exclude_set,
    excluded,
    need_sessions,
    parse,
    session_files,
    sig,
    txt_of,
    version_ok,
    window,
    writer,
)


# These tools are intentionally called repeatedly while waiting or paging results.
EXCLUDED_REPEAT_TOOLS = ('monitor_execution', 'wait', 'read_tool_result')
SEARCH_TOOLS = {'grep_search', 'find_files', 'list_directory', 'web_search'}
LOOKUP_TOOLS = {
    'list_executions', 'list_directory', 'find_files', 'grep_search',
    'read_tool_result',
}
EMPTY_SEARCH_PREFIXES = {
    'grep_search': ('No matches found',),
    'find_files': ('No files match',),
    # Real session rows in the inspected window had no empty list_directory or
    # web_search results. Empty structured/blank results remain unambiguous.
    'list_directory': (),
    'web_search': (),
}


def _args_value(call):
    value = call.get('input')
    if value is None:
        value = call.get('arguments', call.get('args', call.get('raw_arguments', '')))
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            return value
    return value


def _canonical(value):
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    except (TypeError, ValueError):
        return repr(value)


def _arg_text(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _empty_search(tool, result):
    text = result['text'].strip()
    if not text:
        return True
    return any(text.splitlines()[0].startswith(prefix)
               for prefix in EMPTY_SEARCH_PREFIXES.get(tool, ()))


def _write_paths(call):
    if call['name'] not in {'edit_file', 'write_file', 'apply_line_edits'}:
        return set()
    args = call['args']
    if not isinstance(args, dict):
        return set()
    paths = {args['path']} if args.get('path') else set()
    if call['name'] == 'apply_line_edits':
        paths.update(op['path'] for op in args.get('operations', [])
                     if isinstance(op, dict) and op.get('path'))
    return {str(path).replace('\\', '/').lower() for path in paths}


def _shell_reads_path(shell, path):
    command = shell['arg_text'].replace('\\', '/').lower()
    norm = path.replace('\\', '/').lower()
    return norm in command or Path(norm).name in command


def _shell_repeat_is_rerun(earlier, later, calls):
    if earlier['name'] != 'shell':
        return False
    for between in calls[earlier['index'] + 1:later['index']]:
        for path in _write_paths(between):
            if _shell_reads_path(earlier, path):
                return True
    return False


def _shell_program(call):
    args = call['args']
    if not isinstance(args, dict):
        return ''
    command = str(args.get('command') or '').strip()
    return command.split(None, 1)[0] if command else ''


def _shell_exit_code(call):
    match = re.match(r'^exit (\d+)', call['first'].strip())
    return int(match.group(1)) if match else None


def _display_call(call):
    return '%s args=%s' % (call['name'], call['arg_text'][:160])


def _display_result(call):
    return 'result=%s' % call['first'][:160]


def _example(involved, chat_id, start_ts, model, extra=''):
    rendered = []
    for call in involved:
        rendered.extend((_display_call(call), _display_result(call)))
    if extra:
        rendered.append(extra)
    return {
        'chat': chat_id,
        'time': time.strftime('%Y-%m-%d %H:%M:%S %Z', time.localtime(start_ts / 1000)),
        'model': model,
        'calls': rendered,
    }


opts = parse('scan session logs for struggle patterns')
need_sessions(opts.sessions)
CUT_S, CUT_E = window(opts)
CUT_S_MS, CUT_E_MS = CUT_S * 1000, CUT_E * 1000
EXCLUDED_CHATS = exclude_set(opts.exclude)

occurrences = {
    'identical_repeat': [],
    'empty_search_chain': [],
    'detour_after_refusal': [],
}
chat_ids = set()
calls_read = 0

for path in session_files(opts.sessions):
    if os.path.getmtime(path) < CUT_S:
        continue
    chat_id = os.path.basename(path)[:-6]
    if excluded(chat_id, EXCLUDED_CHATS):
        continue
    cur_version = '?'
    pending = {}
    calls = []
    user_turn = 0
    for line in open(path, encoding='utf-8', errors='replace'):
        try:
            row = json.loads(line)
        except Exception:
            continue
        ts = row.get('timestamp_ms') or 0
        row_type = row.get('type') or row.get('role')
        if row_type == 'user':
            user_turn += 1
        if row_type == 'session_start':
            cur_version = row.get('forge_version') or '?'
        if ts < CUT_S_MS or ts > CUT_E_MS:
            continue
        if row_type == 'assistant':
            model = row.get('model') or '?'
            for raw_call in row.get('tool_calls') or []:
                call_id = raw_call.get('id')
                if not call_id:
                    continue
                args = _args_value(raw_call)
                arg_text = _arg_text(args) if not isinstance(args, str) else args
                pending[call_id] = {
                    'id': call_id,
                    'name': raw_call.get('name') or '?',
                    'args': args,
                    'arg_key': _canonical(args),
                    'arg_text': arg_text,
                    'model': model,
                    'call_ts': ts,
                    'version': cur_version,
                    'user_turn': user_turn,
                }
        elif row_type == 'tool':
            if not version_ok(cur_version, opts.min_version):
                continue
            call_id = row.get('tool_call_id')
            paired = pending.get(call_id, {})
            name = row.get('name') or paired.get('name') or '?'
            body = txt_of(row.get('content'))
            first = body.split('\n')[0]
            args = paired.get('args', '')
            arg_text = paired.get('arg_text') or (args if isinstance(args, str) else _arg_text(args))
            calls.append({
                'id': call_id or '',
                'name': name,
                'args': args,
                'arg_key': paired.get('arg_key', _canonical(args)),
                'arg_text': arg_text,
                'text': body,
                'first': first,
                'failed': bucket(first) is not None,
                'ts': ts,
                'model': row.get('model') or paired.get('model') or '?',
                'user_turn': paired.get('user_turn', user_turn),
                'index': len(calls),
            })
    calls.sort(key=lambda call: call['ts'])
    for index, call in enumerate(calls):
        call['index'] = index
    if not calls:
        continue
    chat_ids.add(chat_id)
    calls_read += len(calls)

    # One occurrence per repeated call, paired with the nearest eligible earlier
    # call in the preceding eight results.
    for i, current in enumerate(calls):
        if current['name'] in EXCLUDED_REPEAT_TOOLS:
            continue
        earliest = max(0, i - 7)
        for previous in reversed(calls[earliest:i]):
            if previous['user_turn'] != current['user_turn']:
                continue
            if previous['name'] != current['name'] or previous['arg_key'] != current['arg_key']:
                continue
            if previous['failed'] or _shell_repeat_is_rerun(previous, current, calls):
                continue
            if previous['text'] != current['text']:
                continue
            occurrences['identical_repeat'].append({
                'key': (current['name'],),
                'example': _example([previous, current], chat_id,
                                    current['ts'], current['model']),
            })
            break

    # Maximal adjacent chains stop on the first non-search or non-empty result.
    chain = []
    for call in calls + [{'name': None, 'user_turn': None}]:
        if chain and call.get('user_turn') != chain[-1]['user_turn']:
            if len(chain) >= 3 and len({c['arg_key'] for c in chain}) == len(chain):
                occurrences['empty_search_chain'].append({
                    'key': (chain[0]['name'],),
                    'example': _example(chain, chat_id, chain[0]['ts'], chain[0]['model']),
                })
            chain = []
        if call['name'] in SEARCH_TOOLS and _empty_search(call['name'], call):
            chain.append(call)
            continue
        if len(chain) >= 3 and len({c['arg_key'] for c in chain}) == len(chain):
            occurrences['empty_search_chain'].append({
                'key': (chain[0]['name'],),
                'example': _example(chain, chat_id, chain[0]['ts'], chain[0]['model']),
            })
        chain = []

    # A failed call followed by a successful lookup is a detour, whether or not
    # the original tool succeeds in the three calls after that lookup.
    for i, failure in enumerate(calls):
        if not failure['failed']:
            continue
        for lookup_index in range(i + 1, min(len(calls), i + 4)):
            lookup = calls[lookup_index]
            # A lookup by the failed tool itself is a plain retry, which
            # recovery_cost.py already measures; a detour goes through another tool.
            if (lookup['user_turn'] != failure['user_turn'] or lookup['name'] not in LOOKUP_TOOLS
                    or lookup['name'] == failure['name'] or lookup['failed']):
                continue
            success_index = next((j for j in range(lookup_index + 1, min(len(calls), lookup_index + 4))
                                  if calls[j]['user_turn'] == failure['user_turn']
                                  and calls[j]['name'] == failure['name'] and not calls[j]['failed']), None)
            if failure['name'] == 'shell':
                exit_code = _shell_exit_code(failure)
                same_program = (success_index is not None
                                and _shell_program(failure) == _shell_program(calls[success_index]))
                if exit_code not in (126, 127) and not same_program:
                    continue
            involved = [failure, lookup]
            if success_index is not None:
                involved.append(calls[success_index])
            occurrences['detour_after_refusal'].append({
                'key': (failure['name'], lookup['name'], sig(failure['first']),
                        'resolved' if success_index is not None else 'not resolved'),
                'example': _example(involved, chat_id,
                                    failure['ts'], failure['model'],
                                    'resolution=%s' % ('resolved' if success_index is not None else 'not resolved')),
            })
            break


def _table_rows(pattern):
    counts = collections.Counter(item['key'] for item in occurrences[pattern])
    if pattern == 'detour_after_refusal':
        yield ('X\tlookup tool\tmasked first line\tresolution\toccurrences',)
        for key, count in counts.most_common():
            yield ('%s\t%s\t%s\t%s\t%d' % (*key, count),)
    else:
        yield ('tool\toccurrences',)
        for key, count in counts.most_common():
            yield ('%s\t%d' % (key[0], count),)


with writer(opts.out, 'struggles') as out:
    out.write('SESSION STRUGGLE PATTERNS\n')
    out.write('WINDOW_START %s\n' % time.strftime('%Y-%m-%d %H:%M:%S %Z', time.localtime(CUT_S)))
    out.write('WINDOW_END %s\n' % time.strftime('%Y-%m-%d %H:%M:%S %Z', time.localtime(CUT_E)))
    out.write('MIN_VERSION %s\n' % (opts.min_version or 'none'))
    out.write('CHATS %d\nTOOL_CALLS %d\n' % (len(chat_ids), calls_read))
    out.write('EXCLUDED_REPEAT_TOOLS %s\n\n' % ', '.join(EXCLUDED_REPEAT_TOOLS))
    for pattern in ('identical_repeat', 'empty_search_chain', 'detour_after_refusal'):
        items = occurrences[pattern]
        chats = {item['example']['chat'] for item in items}
        out.write('## %s\nTOTAL %d\nCHATS_WITH_PATTERN %d\n' %
                  (pattern, len(items), len(chats)))
        out.write('TABLE\n')
        for (line,) in _table_rows(pattern):
            out.write(line + '\n')
        out.write('EXAMPLES\n')
        examples = items
        for item in examples[:5]:
            ex = item['example']
            out.write('chat=%s time=%s model=%s\n' % (ex['chat'], ex['time'], ex['model']))
            for call in ex['calls']:
                out.write('  %s\n' % call)
        out.write('\n')

print('CHATS', len(chat_ids), 'TOOL_CALLS', calls_read)
for pattern in ('identical_repeat', 'empty_search_chain', 'detour_after_refusal'):
    print(pattern, len(occurrences[pattern]), 'chats',
          len({item['example']['chat'] for item in occurrences[pattern]}))
print('WROTE', Path(opts.out) / OUT_FILES['struggles'])
