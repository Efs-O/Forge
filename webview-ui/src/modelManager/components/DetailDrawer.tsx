import React, { useState } from 'react';
import type { ModelManagerModelView } from '../../../../src/sidebar/modelManager/messages';
import { IdentityTab } from './detail/IdentityTab';
import { LocationTab } from './detail/LocationTab';
import { RuntimeTab } from './detail/RuntimeTab';
import { RequestTab } from './detail/RequestTab';
import { SamplingTab } from './detail/SamplingTab';
import { ToolsTab } from './detail/ToolsTab';

const TABS = ['Identity', 'Location', 'Runtime', 'Request', 'Sampling', 'Tools'] as const;
type Tab = (typeof TABS)[number];

interface Props {
  model: ModelManagerModelView;
  errorField: string | null;
  onEdit: (field: string, value: unknown) => void;
  onReveal: () => void;
  onRemove: () => void;
  onPurge: () => void;
  onLoadAndTry: () => void;
  onClose: () => void;
}

/** Right-hand detail drawer — tabbed param editor, secondary to the
 *  list/lifecycle front page (§2.3). Autosaves per-field on commit. */
export function DetailDrawer({
  model,
  errorField,
  onEdit,
  onReveal,
  onRemove,
  onPurge,
  onLoadAndTry,
  onClose,
}: Props): React.ReactElement {
  const [tab, setTab] = useState<Tab>('Identity');

  return (
    <aside className="mm-drawer" aria-label={`Details for ${model.name}`}>
      <div className="mm-drawer-header">
        <h2>{model.name}</h2>
        <button className="mm-close-btn" onClick={onClose} aria-label="Close (Esc)">
          ✕
        </button>
      </div>
      <div className="mm-drawer-actions">
        <button onClick={onLoadAndTry}>Load & try</button>
        <button onClick={onReveal} disabled={!model.raw.gguf_path}>
          Reveal in Explorer
        </button>
        <button className="mm-danger-btn" onClick={onRemove}>
          Remove (Del)
        </button>
        <button className="mm-danger-btn" onClick={onPurge}>
          Purge (Ctrl+Del)
        </button>
      </div>
      <nav className="mm-tab-nav">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? 'mm-tab-active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      <div className="mm-tab-body">
        {tab === 'Identity' && (
          <IdentityTab model={model} onEdit={onEdit} errorField={errorField} />
        )}
        {tab === 'Location' && (
          <LocationTab model={model} onEdit={onEdit} errorField={errorField} onReveal={onReveal} />
        )}
        {tab === 'Runtime' && <RuntimeTab model={model} onEdit={onEdit} errorField={errorField} />}
        {tab === 'Request' && <RequestTab model={model} onEdit={onEdit} errorField={errorField} />}
        {tab === 'Sampling' && (
          <SamplingTab model={model} onEdit={onEdit} errorField={errorField} />
        )}
        {tab === 'Tools' && <ToolsTab model={model} onEdit={onEdit} errorField={errorField} />}
      </div>
    </aside>
  );
}
