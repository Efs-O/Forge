import React from 'react';
import type { OrphanGguf } from '../../../../src/sidebar/modelManager/messages';
import { formatBytes } from '../formatters';

interface Props {
  orphans: OrphanGguf[];
  onPurge: (path: string) => void;
}

/** GGUFs on disk under `model_dirs` referenced by no config entry — pure
 *  wasted space (§2.3 zoo hygiene). */
export function OrphansPanel({ orphans, onPurge }: Props): React.ReactElement | null {
  if (orphans.length === 0) return null;
  return (
    <section className="mm-orphans">
      <h3>Orphan GGUFs ({orphans.length})</h3>
      <ul>
        {orphans.map((o) => (
          <li key={o.path}>
            <span className="mm-orphan-path" title={o.path}>
              {o.path}
            </span>
            <span className="mm-size">{formatBytes(o.sizeBytes)}</span>
            <button className="mm-danger-btn" onClick={() => onPurge(o.path)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
