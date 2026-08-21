import React, { useMemo, useState } from 'react';
import type { AppMessage } from '../reducer';
import { ToolRow } from './ToolRow';

const ChevronDown = (): React.ReactElement => (
  <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor" aria-hidden="true">
    <path d="M0 0l5 6 5-6z" />
  </svg>
);

const ChevronRight = (): React.ReactElement => (
  <svg width="6" height="10" viewBox="0 0 6 10" fill="currentColor" aria-hidden="true">
    <path d="M0 0l6 5-6 5z" />
  </svg>
);

function summary(tools: readonly AppMessage[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const name = tool.toolName ?? tool.content.split(' → ', 1)[0] ?? 'tool';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => (count === 1 ? name : `${name} × ${count}`)).join(', ');
}

/** A compact, ordered view of the parallel tool calls issued in one agent step. */
export function ToolGroup({ tools }: { tools: AppMessage[] }): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const label = useMemo(() => summary(tools), [tools]);

  if (tools.length < 2) return tools[0] ? <ToolRow message={tools[0]} /> : null;

  return (
    <div className="tool-group">
      <button
        className="tool-group-toggle"
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="tool-group-chevron">{open ? <ChevronDown /> : <ChevronRight />}</span>
        <span>{tools.length} tool calls</span>
        <span className="tool-group-summary">{label}</span>
      </button>
      {open && (
        <div className="tool-group-body">
          {tools.map((tool) => (
            <ToolRow key={tool.id} message={tool} />
          ))}
        </div>
      )}
    </div>
  );
}
