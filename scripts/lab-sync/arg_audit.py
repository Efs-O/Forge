"""Audit: tool calls that passed an argument their schema does not list.

Schema side: every `name: '<tool>'` definition in src/ plus the `properties:` block that
follows it, keys collected by indentation. Session side: tool calls in today's session
JSONL, their argument keys parsed from raw_arguments. A key in a call but not in the
schema is reported once per tool.

Usage: python scripts/lab-sync/arg_audit.py [session-prefix ...]
"""
import glob
import io
import json
import os
import re
import sys
import time

SRC = os.path.join(os.path.dirname(__file__), '..', '..', 'src')
SESSIONS = os.path.expanduser('~/.forge/sessions')

def schema_keys():
    tools = {}
    for path in glob.glob(os.path.join(SRC, '**', '*.ts'), recursive=True):
        text = io.open(path, encoding='utf-8', errors='replace').read()
        for match in re.finditer(r"name:\s*'([a-z_0-9]+)'", text):
            name = match.group(1)
            tail = text[match.end():match.end() + 4000]
            props = re.search(r'properties:\s*\{', tail)
            if not props:
                continue
            block = tail[props.end():]
            keys = set()
            depth = 1
            for line in block.split('\n'):
                stripped = line.strip()
                if stripped.startswith('}') and depth == 1:
                    break
                depth += line.count('{') - line.count('}')
                key = re.match(r'^([a-z_0-9]+):\s*\{', stripped)
                if key and depth <= 2:
                    keys.add(key.group(1))
            if keys:
                tools[name] = keys
    return tools

def calls(prefixes):
    for path in glob.glob(os.path.join(SESSIONS, '*.jsonl')):
        if os.path.getmtime(path) < time.time() - 12 * 3600:
            continue
        base = os.path.basename(path)[:8]
        if prefixes and not any(base.startswith(p) for p in prefixes):
            continue
        for line in io.open(path, encoding='utf-8', errors='replace'):
            if 'raw_arguments' not in line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            message = row.get('message') if isinstance(row.get('message'), dict) else row
            if not isinstance(message, dict):
                continue
            for call in message.get('tool_calls') or []:
                name = call.get('name') or (call.get('function') or {}).get('name')
                raw = call.get('raw_arguments') or (call.get('function') or {}).get('arguments')
                if not name or not isinstance(raw, str):
                    continue
                try:
                    args = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(args, dict):
                    yield base, name, set(args)

def main():
    prefixes = sys.argv[1:]
    schemas = schema_keys()
    print('tools with a parsed schema:', len(schemas))
    seen = {}
    for chat, name, keys in calls(prefixes):
        props = schemas.get(name)
        if props is None:
            continue
        extra = keys - props
        if extra:
            seen.setdefault(name, set()).update(extra)
            print('MISMATCH', chat, name, 'extra args:', sorted(extra), '| schema:', sorted(props))
    print('--- tools that dropped an unknown argument:', sorted(seen) or 'none')

main()
