import React, { useState } from 'react';
import type { ScanCandidateView } from '../../../../src/sidebar/modelManager/messages';
import { formatBytes } from '../formatters';

interface Props {
  candidates: ScanCandidateView[];
  onScanDirectory: () => void;
  onAddSelected: (picks: Array<{ ggufPath: string; name: string; mmprojPath?: string }>) => void;
  onClose: () => void;
}

/** "Acquire → Register" flow (§2.3 step 1-2): pick a directory, see scan
 *  results with dedupe against configured paths, check the ones to add. */
export function ScanDialog({
  candidates,
  onScanDirectory,
  onAddSelected,
  onClose,
}: Props): React.ReactElement {
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const toggle = (path: string): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const addSelected = (): void => {
    const picks = candidates
      .filter((c) => checked.has(c.ggufPath) && !c.alreadyConfigured)
      .map((c) => ({
        ggufPath: c.ggufPath,
        name: c.suggestedName,
        ...(c.mmprojPath ? { mmprojPath: c.mmprojPath } : {}),
      }));
    if (picks.length > 0) onAddSelected(picks);
  };

  return (
    <div className="mm-modal-backdrop" onClick={onClose}>
      <div
        className="mm-modal mm-modal--wide"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h3>Scan for GGUF models</h3>
        <div className="mm-modal-actions">
          <button onClick={onScanDirectory}>Choose directory…</button>
          <button onClick={onClose}>Close</button>
        </div>
        {candidates.length === 0 ? (
          <p>No results yet — choose a directory to scan.</p>
        ) : (
          <ul className="mm-scan-list">
            {candidates.map((c) => (
              <li key={c.ggufPath} className={c.alreadyConfigured ? 'mm-scan-row--configured' : ''}>
                <input
                  type="checkbox"
                  disabled={c.alreadyConfigured}
                  checked={checked.has(c.ggufPath)}
                  onChange={() => toggle(c.ggufPath)}
                />
                <span className="mm-scan-name">{c.suggestedName}</span>
                <span className="mm-badge">{c.family}</span>
                {c.quant ? <span className="mm-badge">{c.quant}</span> : null}
                <span className="mm-size">{formatBytes(c.sizeBytes)}</span>
                {c.mmprojPath ? <span className="mm-badge">+mmproj</span> : null}
                {c.alreadyConfigured ? <span className="mm-badge">already configured</span> : null}
              </li>
            ))}
          </ul>
        )}
        <div className="mm-modal-actions">
          <button disabled={checked.size === 0} onClick={addSelected}>
            Add selected ({checked.size})
          </button>
        </div>
      </div>
    </div>
  );
}
