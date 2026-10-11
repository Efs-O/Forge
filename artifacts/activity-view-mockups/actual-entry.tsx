import React from 'react';
import { createRoot } from 'react-dom/client';
import type { AppMessage } from '../../webview-ui/src/messageOps';
import type { ActivityGroupItem } from '../../webview-ui/src/activityRows';
import { Message } from '../../webview-ui/src/components/Message';
import { ActivityGroup } from '../../webview-ui/src/components/ActivityGroup';
import { QueuedPromptRow } from '../../webview-ui/src/components/QueuedPromptRow';
import '../../webview-ui/styles/base.css';
import '../../webview-ui/styles/messages.css';
import '../../webview-ui/styles/activity-group.css';
import '../../webview-ui/styles/activity-row.css';
import '../../webview-ui/styles/tool-rows.css';
import '../../webview-ui/styles/diff.css';
import '../../webview-ui/styles/input.css';

const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') ?? 'complete';
const light = params.get('theme') === 'light';
if (light) document.body.classList.add('vscode-light');
const tool = (id: string, name: string, detail: string, pending = false): AppMessage => ({
  id, role: 'tool', content: `${name} → ${detail}`, toolName: name,
  toolTarget: detail, toolDetail: detail,
  ...(pending ? {} : { toolResult: 'checks passed', toolResultTotal: 13, toolMs: 400 }),
});
const first: ActivityGroupItem[] = [{ kind: 'step', step: {
  attempts: [{ thoughts: [], tools: [tool('scan', 'shell', 'grep -n max_context serve/server.py')] }],
  diffs: [],
} }];
const second: ActivityGroupItem[] = [{ kind: 'step', step: {
  attempts: [{ thoughts: [], tools: [tool('edit', 'apply_line_edits', 'serve/server.py')] }],
  diffs: [{ id: 'diff', role: 'diff', content: 'serve/server.py', diffHunks: [{
    oldStart: 1, newStart: 1, lines: [
      { kind: 'added', text: 'new argument' }, { kind: 'removed', text: 'old argument' },
    ],
  }] }],
} }];
const live: ActivityGroupItem[] = [
  second[0]!,
  { kind: 'step', step: {
    attempts: [{ thoughts: [], tools: [tool('verify', 'shell',
      'grep -n max_context serve/server.py; sed -n 6074,6091p serve/server.py', true)] }],
    diffs: [],
  } },
];

function Demo(): React.ReactElement {
  return <>
    <header className="demo-header"><b>✸ Forge</b><span>Sessions</span></header>
    <main className="demo-transcript">
      <Message id="prompt" role="user" content="Please finish the --max-context patch in serve/server.py. Keep the replicas path and verify both startup paths." />
      <Message id="intro" role="assistant" content="I’ll inspect both startup paths and apply the override." />
      <ActivityGroup items={first} live={false} streaming={false} />
      <Message id="middle" role="assistant" content="The replicas branch has a separate argument builder. I’ve updated both paths." />
      <ActivityGroup items={mode === 'queued' || mode === 'clanker' ? live : second} live={mode === 'queued' || mode === 'clanker'} streaming={mode === 'queued' || mode === 'clanker'} />
      {mode === 'queued' || mode === 'clanker'
        ? <QueuedPromptRow text="OK" attachmentCount={0} tell onCancel={() => undefined} />
        : <Message id="final" role="assistant" content="Done. The override now reaches both startup paths. Targeted checks passed." />}
    </main>
    <div className="demo-status">{mode === 'clanker' ? '● Clanker active · no confirmations' : mode === 'queued' ? '● Working…' : '✓ Finished'}</div>
    <div id="input-row"><div id="prompt-area"><div id="prompt-shell"><textarea id="prompt" readOnly placeholder="Ask or / for commands…" className={mode === 'clanker' ? 'clanker-armed' : undefined} /></div></div></div>
  </>;
}

createRoot(document.getElementById('root')!).render(<Demo />);
