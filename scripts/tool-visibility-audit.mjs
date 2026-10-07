import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Mirrors src/sessions/sessionLogRows.ts, the reader used by ArchivedSessions.
// That TypeScript module has extensionless imports and cannot load in standalone Node.
export function dedupeRows(parsedRows) {
  const rows = [];
  const historyHashes = [];
  const acceptedHashes = [];
  const starts = new Map();
  const hash = (row) => {
    const canonical = { ...row };
    delete canonical.timestamp_ms;
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  };
  const hashes = parsedRows.map(hash);
  const hasCursor = parsedRows.some((row) => row.type === 'cursor');
  let expected;
  let buffer = [];
  const append = (row, value) => {
    rows.push(row);
    if (!starts.has(value)) starts.set(value, []);
    starts.get(value).push(acceptedHashes.length);
    acceptedHashes.push(value);
    if (['user', 'assistant', 'tool'].includes(row.role)) historyHashes.push(value);
  };
  const flush = () => {
    for (const item of buffer) append(item.row, item.hash);
    buffer = [];
    expected = undefined;
  };
  for (let index = 0; index < parsedRows.length; index++) {
    const row = parsedRows[index];
    if (row.type === 'cursor' && typeof row.written_count === 'number') {
      flush();
      expected = hasCursor ? historyHashes.slice(0, Math.max(0, row.written_count)) : undefined;
      if (expected?.length === 0) expected = undefined;
      rows.push(row);
      continue;
    }
    const value = hashes[index];
    if (expected && ['user', 'assistant', 'tool'].includes(row.role)) {
      if (value === expected[buffer.length]) {
        buffer.push({ row, hash: value });
        if (buffer.length === expected.length) {
          buffer = [];
          expected = undefined;
        }
        continue;
      }
      flush();
    }
    if (!hasCursor) {
      let replayLength = 0;
      for (const start of starts.get(value) ?? []) {
        let length = 0;
        while (index + length < parsedRows.length && start + length < acceptedHashes.length &&
          hashes[index + length] === acceptedHashes[start + length]) length++;
        replayLength = Math.max(replayLength, length);
      }
      if (replayLength >= 2) {
        index += replayLength - 1;
        continue;
      }
    }
    append(row, value);
  }
  flush();
  return rows;
}

export function pairCalls(rows) {
  const results = new Map();
  for (const row of rows) {
    if (row.role === 'tool' && typeof row.tool_call_id === 'string' &&
      !results.has(row.tool_call_id)) results.set(row.tool_call_id, row);
  }
  return rows.flatMap((row) => row.role === 'assistant' && Array.isArray(row.tool_calls)
    ? row.tool_calls.filter((call) => call && typeof call.name === 'string')
      .map((call) => ({ call, row, result: results.get(call.id) }))
    : []);
}

const commandTokens = (command) => command.match(/[\w@.\\/:-]+/gu)?.map((token) => token.toLowerCase()) ?? [];
const WORKAROUND_RULES = [
  { command: 'npm/pnpm install three, puppeteer, or playwright; Node script importing one', tool: 'render_html_to_image' },
  { command: 'git commit', tool: 'commit' },
  { command: 'git mv, mv, Move-Item', tool: 'move_file' },
  { command: 'mkdir, New-Item -ItemType Directory', tool: 'create_directory' },
  { command: 'rm, Remove-Item', tool: 'delete_file' },
  { command: 'sleep, Start-Sleep', tool: 'background wait' },
];
const executable = (token) => path.win32.basename(token).replace(/\.exe$/u, '');
const scriptKey = (value) => value.toLowerCase().replaceAll('\\', '/').replace(/^\.\//u, '');
const hasSequence = (tokens, ...sequence) => tokens.some((token, index) =>
  executable(token) === sequence[0] && sequence.slice(1).every((part, offset) =>
    tokens[index + offset + 1] === part));
const hasPackage = (tokens) => tokens.some((token) =>
  /^(?:three|puppeteer|playwright|playwright-core)(?:@\d[\w.-]*)?$/u.test(token));

function recordShellScript(command, scripts) {
  // A shell heredoc can create a Node script without a Forge write_file row.
  const match = command.match(/\bcat\s*>\s*([^\s]+\.(?:c|m)?js)\s*<<\s*['"]?([\w-]+)['"]?\r?\n([\s\S]*?)\r?\n\2(?:\s|$)/u);
  if (match) scripts[scriptKey(match[1])] = match[3];
}

/** A conservative command classifier: every command word and package is a full token. */
export function workaroundTargets(command, scriptSources = {}) {
  if (typeof command !== 'string') return [];
  const tokens = commandTokens(command);
  const targets = new Set();
  if (tokens.some((token, index) => ['npm', 'pnpm'].includes(executable(token)) &&
      ['i', 'install', 'add'].includes(tokens[index + 1])) && hasPackage(tokens)) {
    targets.add('render_html_to_image');
  }
  if (tokens.some((token) => ['node', 'nodejs'].includes(executable(token)))) {
    const source = tokens.filter((token) => /\.(?:c|m)?js$/u.test(token))
      .map((token) => scriptSources[scriptKey(token)] ?? '').join('\n');
    const code = `${command}\n${source}`;
    if (/\b(?:require\s*\(|from\s+|import\s*\()\s*['"](?:three|puppeteer|playwright(?:-core)?)(?:\/[^'"]*)?['"]/u.test(code)) {
      targets.add('render_html_to_image');
    }
  }
  if (hasSequence(tokens, 'git', 'commit')) targets.add('commit');
  if (hasSequence(tokens, 'git', 'mv') || tokens.some((token) =>
    ['mv', 'move-item'].includes(executable(token)))) targets.add('move_file');
  if (tokens.some((token) => executable(token) === 'mkdir') ||
    tokens.some((token, index) => executable(token) === 'new-item' &&
      tokens.slice(index + 1).some((next, offset) => next === '-itemtype' &&
        tokens[index + offset + 2] === 'directory'))) targets.add('create_directory');
  if (!hasSequence(tokens, 'git', 'rm') &&
    !tokens.some((token) => /^-[a-z]*r[a-z]*$/u.test(token) || token === '-recurse') &&
    tokens.some((token) => ['rm', 'remove-item'].includes(executable(token)))) {
    targets.add('delete_file');
  }
  if (tokens.some((token) => ['sleep', 'start-sleep'].includes(executable(token)))) {
    targets.add('background wait');
  }
  return [...targets];
}

const failed = (row, name) => {
  const content = row?.content;
  return typeof content === 'string' &&
    (/^(?:Error:|User declined:)/u.test(content) ||
      (['shell', 'exec_command'].includes(name) && /^exit (?!0\b)(?:\d+|null)\b/u.test(content)));
};

export function auditSessions(sessions, toolNames, since = -Infinity) {
  const stats = new Map([...toolNames].map((name) => [name, {
    tool: name, sessionsOffered: 0, sessionsCalled: 0, calls: 0, failures: 0,
    workaroundCalls: 0, workaroundSessions: 0,
  }]));
  const sessionIds = new Set();
  for (const { id, rows } of sessions) {
    if (!rows.some((row) => typeof row.timestamp_ms === 'number' && row.timestamp_ms >= since)) continue;
    sessionIds.add(id);
    const offered = new Set();
    const everOffered = new Set(rows.filter((row) => row.type === 'tools_offered')
      .flatMap((row) => Array.isArray(row.names) ? row.names : []));
    const called = new Set();
    const workaroundCandidates = new Map();
    let visible = new Set();
    const scripts = {};
    const results = new Map(pairCalls(rows).map(({ call, result }) => [call.id, result]));
    for (const row of rows) {
      if (row.type === 'tools_offered' && Array.isArray(row.names)) {
        visible = new Set(row.names.filter((name) => typeof name === 'string'));
      }
      if (row.role === 'assistant' && Array.isArray(row.tool_calls)) {
        for (const call of row.tool_calls) {
          if (['write_file', 'append_file'].includes(call?.name) &&
            typeof call.input?.path === 'string' && typeof call.input?.content === 'string') {
            const key = scriptKey(call.input.path);
            scripts[key] = call.name === 'append_file'
              ? `${scripts[key] ?? ''}${call.input.content}` : call.input.content;
          }
          if (['shell', 'exec_command'].includes(call?.name)) {
            const command = call.input?.command ?? call.input?.cmd;
            if (typeof command === 'string') recordShellScript(command, scripts);
          }
        }
      }
      if (typeof row.timestamp_ms !== 'number' || row.timestamp_ms < since) continue;
      for (const name of visible) offered.add(name);
      if (row.role !== 'assistant' || !Array.isArray(row.tool_calls)) continue;
      for (const call of row.tool_calls) {
        if (!call || typeof call.name !== 'string') continue;
        if (visible.has(call.name)) {
          const stat = stats.get(call.name);
          if (stat) {
            called.add(call.name);
            stat.calls++;
            if (failed(results.get(call.id), call.name)) stat.failures++;
          }
        }
        if (!['shell', 'exec_command'].includes(call.name)) continue;
        const command = call.input?.command ?? call.input?.cmd;
        for (const name of workaroundTargets(command, scripts)) {
          if (visible.has(name)) continue;
          if (stats.has(name)) workaroundCandidates.set(name,
            (workaroundCandidates.get(name) ?? 0) + 1);
        }
      }
    }
    for (const name of offered) if (stats.has(name)) stats.get(name).sessionsOffered++;
    for (const name of called) if (stats.has(name)) stats.get(name).sessionsCalled++;
    for (const [name, count] of workaroundCandidates) {
      if (everOffered.has(name)) continue;
      stats.get(name).workaroundCalls += count;
      stats.get(name).workaroundSessions++;
    }
  }
  return { sessions: sessionIds.size, tools: [...stats.values()].map((stat) => ({
    ...stat,
    sessionsOffered: stat.sessionsOffered || 'unmeasured',
    sessionsCalled: stat.sessionsOffered ? stat.sessionsCalled : 'unmeasured',
    calls: stat.sessionsOffered ? stat.calls : 'unmeasured',
    failures: stat.sessionsOffered ? stat.failures : 'unmeasured',
  })) };
}

export function selfRuledOutNotes(offeredNames, descriptions) {
  return [...offeredNames].sort().flatMap((tool) => {
    const description = descriptions.get(tool) ?? '';
    return description.split(/(?<=[.!?])\s+/u)
      .filter((sentence) => /\b(?:does not|do not|cannot|not supported|unsupported|no javascript|no timeout|only supports|only works|only when|only for|requires)\b/iu.test(sentence))
      .filter((sentence) => !sentence.includes("' +") && sentence.length <= 350)
      .map((sentence) => ({ tool, note: sentence.trim() }));
  });
}

function readRows(filename) {
  const parsed = [];
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) parsed.push(row);
    } catch { /* Torn log rows are ignored, like readSessionLogRows. */ }
  }
  return dedupeRows(parsed);
}

function parseArgs(args) {
  const paths = [];
  let since = -Infinity;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--json') json = true;
    else if (args[index] === '--since') {
      const value = args[++index];
      since = Date.parse(value);
      if (!value || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value) ||
        !Number.isFinite(since)) throw new Error('--since requires an ISO date');
    } else if (args[index].startsWith('-')) throw new Error(`Unknown option: ${args[index]}`);
    else paths.push(args[index]);
  }
  return { paths: paths.length ? paths : [path.join(os.homedir(), '.forge', 'sessions')], since, json };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = options.paths.flatMap((entry) => fs.statSync(entry).isDirectory()
    ? fs.readdirSync(entry).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(entry, name))
    : [entry]);
  const sessions = [...new Set(files)].map((file) => ({ id: path.resolve(file), rows: readRows(file) }));
  const { extractToolDefinitions } = await import('./tool-audit-catalog.mjs');
  const descriptions = new Map(extractToolDefinitions().map((definition) => [
    definition.function.name, definition.function.description ?? '',
  ]));
  const namesOfferedInWindow = new Set(sessions.flatMap(({ rows }) => {
    if (!rows.some((row) => typeof row.timestamp_ms === 'number' &&
      row.timestamp_ms >= options.since)) return [];
    return rows.filter((row) => row.type === 'tools_offered').flatMap((row) => row.names ?? []);
  }));
  for (const { rows } of sessions) for (const row of rows) {
    if (row.type !== 'tools_offered' || !row.descriptions) continue;
    for (const [name, description] of Object.entries(row.descriptions)) {
      if (typeof description === 'string') descriptions.set(name, description);
    }
  }
  const calledNames = sessions.flatMap(({ rows }) => rows.flatMap((row) =>
    Array.isArray(row.tool_calls) ? row.tool_calls.map((call) => call?.name).filter(Boolean) : []));
  const names = new Set([...descriptions.keys(), ...namesOfferedInWindow, ...calledNames,
    'commit', 'move_file', 'create_directory', 'render_html_to_image', 'background wait']);
  const counts = auditSessions(sessions, names, options.since);
  const offeredNames = new Set(counts.tools.filter((item) => item.sessionsOffered !== 'unmeasured')
    .map((item) => item.tool));
  const report = { since: Number.isFinite(options.since) ? new Date(options.since).toISOString() : null,
    ...counts,
    workarounds: WORKAROUND_RULES.map((rule) => ({ ...rule,
      calls: counts.tools.find((item) => item.tool === rule.tool)?.workaroundCalls ?? 0,
      sessions: counts.tools.find((item) => item.tool === rule.tool)?.workaroundSessions ?? 0,
    })),
    notes: selfRuledOutNotes(offeredNames, descriptions) };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  console.log(`# Tool visibility audit (${report.sessions} sessions)`);
  console.log('| Tool | Sessions offered | Sessions called | Calls | Failures | Hidden workaround calls (sessions) |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const stat of report.tools.sort((a, b) => b.workaroundCalls - a.workaroundCalls ||
    (typeof b.calls === 'number' ? b.calls : -1) - (typeof a.calls === 'number' ? a.calls : -1) ||
    a.tool.localeCompare(b.tool))) {
    console.log(`| ${stat.tool} | ${stat.sessionsOffered} | ${stat.sessionsCalled} | ${stat.calls} | ${stat.failures} | ${stat.workaroundCalls} (${stat.workaroundSessions}) |`);
  }
  console.log('\n| Shell command pattern | Hidden tool | Calls | Sessions |');
  console.log('| --- | --- | ---: | ---: |');
  for (const rule of report.workarounds) {
    console.log(`| ${rule.command} | ${rule.tool} | ${rule.calls} | ${rule.sessions} |`);
  }
  console.log('\nSelf-ruled-out description notes (not counts):');
  for (const { tool, note } of report.notes) console.log(`- ${tool}: ${note.replaceAll('|', '\\|')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
