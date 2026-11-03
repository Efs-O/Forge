import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentLinks } from '../../src/agentLinks/chatAgentLinks';
import type { SessionHistoryMeta, SessionTabMeta } from '../../src/sidebar/messageBridge';
import { Header } from '../../webview-ui/src/components/Header';
import { ChatHeader } from '../../webview-ui/src/components/ChatHeader';
import { HistoryList } from '../../webview-ui/src/components/HistoryList';

declare global {
  interface Window {
    setSessionLayoutTheme(theme: 'dark' | 'light'): void;
    sessionLayoutActions: string[];
  }
}

const links: AgentLinks = {
  codex: {
    kind: 'codex',
    sessionId: '22222222-2222-4222-8222-222222222222',
    cwd: 'C:/repo',
    title: 'Codex layout review',
    linkedAt: 1,
    lastUsedAt: 1,
    origin: 'forge-created',
  },
  claude: {
    kind: 'claude',
    sessionId: '11111111-1111-4111-8111-111111111111',
    cwd: 'C:/repo',
    title: 'Claude layout review',
    linkedAt: 1,
    lastUsedAt: 1,
    origin: 'forge-created',
  },
};

const openItems: SessionTabMeta[] = [
  {
    id: 'open-codex',
    title: 'A title long enough to exercise the flexible session column',
    createdAt: 1,
    updatedAt: 1,
    messageCount: 8,
    title_source: 'prompt',
    origin_agent: 'Codex',
    keep_open: true,
  },
  {
    id: 'open-you',
    title: 'A second conversation title',
    createdAt: 1,
    updatedAt: 1,
    messageCount: 3,
  },
];

const archived: SessionHistoryMeta[] = openItems.map((item) => ({
  id: `closed-${item.id}`,
  title: item.title,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
  messageCount: item.messageCount,
  title_source: item.title_source,
  origin_agent: item.origin_agent,
}));

function Fixture(): React.ReactElement {
  const [expanded, setExpanded] = useState(true);
  const [title, setTitle] = useState('A long active session title for responsive layout');
  const [open, setOpen] = useState(openItems);
  window.sessionLayoutActions ??= [];
  const record = (action: string): void => {
    window.sessionLayoutActions.push(action);
  };
  window.setSessionLayoutTheme = (theme) => {
    document.body.className = theme === 'light' ? 'vscode-light' : 'vscode-dark';
  };
  return (
    <div id="forge-root">
      <Header
        tokenUsed={100}
        tokenMax={32_000}
        workspace={{
          name: 'Forge',
          path: 'C:/repo',
          extraRoots: 0,
          stale: false,
          forgeIconUri:
            'data:image/svg+xml,' +
            encodeURIComponent(
              '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
                '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/>' +
                '<rect x="9" y="4" width="1.5" height="3" rx="0.5" fill="currentColor"/>' +
                '<rect x="13.5" y="4" width="1.5" height="3" rx="0.5" fill="currentColor"/>' +
                '<rect x="9" y="17" width="1.5" height="3" rx="0.5" fill="currentColor"/>' +
                '<rect x="13.5" y="17" width="1.5" height="3" rx="0.5" fill="currentColor"/>' +
                '<rect x="4" y="9" width="3" height="1.5" rx="0.5" fill="currentColor"/>' +
                '<rect x="4" y="13.5" width="3" height="1.5" rx="0.5" fill="currentColor"/>' +
                '<rect x="17" y="9" width="3" height="1.5" rx="0.5" fill="currentColor"/>' +
                '<rect x="17" y="13.5" width="3" height="1.5" rx="0.5" fill="currentColor"/>' +
                '</svg>',
            ),
        }}
      />
      <aside id="chats-panel" aria-label="Forge sessions">
        <ChatHeader
          title={title}
          historyExpanded={expanded}
          agentLinks={links}
          onUnlinkAgent={(kind) => record(`unlink:${kind}`)}
          onRename={setTitle}
          onNew={() => {
            record('new');
            setTitle('Untitled chat');
          }}
          onToggleHistory={() => setExpanded((value) => !value)}
        />
        <HistoryList
          items={[]}
          archived={archived}
          openItems={open}
          activeId="open-codex"
          jobs={[
            {
              id: 'job-check',
              name: 'Engine update',
              enabled: true,
              schedule: 'daily at 08:00',
              description: 'Engine update job',
              lastOutcomeLabel: 'ok',
              consecutiveFailures: 0,
              lastRun: null,
              runningConversationId: null,
            },
          ]}
          onOpenJob={(id) => record(`job:${id}`)}
          expanded={expanded}
          onDismiss={() => setExpanded(false)}
          onRestore={(id) => record(`restore:${id}`)}
          onDelete={(id) => record(`delete:${id}`)}
          onRename={(id, value) => record(`rename:${id}:${value}`)}
          onClose={(id) => {
            record(`close:${id}`);
            setOpen((items) => items.filter((item) => item.id !== id));
          }}
          onSetKeepOpen={(id, keep) => {
            record(`pin:${id}:${keep}`);
            setOpen((items) =>
              items.map((item) => (item.id === id ? { ...item, keep_open: keep } : item)),
            );
          }}
          onSwitchOpen={(id) => record(`switch:${id}`)}
        />
      </aside>
      <div id="transcript-slot" />
    </div>
  );
}

const mount = document.getElementById('root');
if (!mount) throw new Error('session layout fixture root was not found');
createRoot(mount).render(<Fixture />);
