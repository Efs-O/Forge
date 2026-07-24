import React from 'react';
import type { SortKey } from '../reducer';
import { formatBytes } from '../formatters';

interface Props {
  filter: string;
  onFilterChange: (v: string) => void;
  filterInputRef: React.RefObject<HTMLInputElement | null>;
  count: number;
  totalDiskBytes: number;
  sortKey: SortKey;
  sortDesc: boolean;
  onSort: (key: SortKey) => void;
  unusedOnly: boolean;
  onToggleUnusedOnly: () => void;
  onScan: () => void;
  onEditGroups: () => void;
}

export function Toolbar({
  filter,
  onFilterChange,
  filterInputRef,
  count,
  totalDiskBytes,
  sortKey,
  sortDesc,
  onSort,
  unusedOnly,
  onToggleUnusedOnly,
  onScan,
  onEditGroups,
}: Props): React.ReactElement {
  const sortLabel = (key: SortKey, label: string): string =>
    sortKey === key ? `${label} ${sortDesc ? '↓' : '↑'}` : label;

  return (
    <div className="mm-toolbar">
      <div className="mm-toolbar-summary">
        <strong>{count}</strong> models · <strong>{formatBytes(totalDiskBytes)}</strong> on disk
      </div>
      <input
        ref={filterInputRef}
        className="mm-filter"
        placeholder="/ filter by name, short_name, group, category"
        value={filter}
        onChange={(e) => onFilterChange(e.target.value)}
      />
      <div className="mm-sort-group">
        <button onClick={() => onSort('name')}>{sortLabel('name', 'Name')}</button>
        <button onClick={() => onSort('size')}>{sortLabel('size', 'Size')}</button>
        <button onClick={() => onSort('lastUsed')}>{sortLabel('lastUsed', 'Last used')}</button>
      </div>
      <label className="mm-unused-toggle">
        <input type="checkbox" checked={unusedOnly} onChange={onToggleUnusedOnly} />
        Unused 30+ days
      </label>
      <button onClick={onScan}>Scan directory…</button>
      <button onClick={onEditGroups}>Groups editor</button>
    </div>
  );
}
